import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, recoveryForAIError, type AIProvider } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { scanWork } from "../core/scanner";
import { readTextFile, hashText } from "../core/textFile";
import { blankMemoLines } from "../core/sceneMemo";
import { pathExists } from "../core/fileSystem";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { readWorkFormat } from "../core/workFormatStore";
import { formatChapterLabel } from "../core/episodeLabel";
import {
  EPISODE_PLOT_CHECK_LABELS,
  episodePlotChapterOf,
  episodePlotChecksFor,
  type EpisodePlotCheckAction,
} from "../core/plotMode";
import {
  EPISODE_PLOTS_DIR,
  episodePlotChapterFromFileName,
  episodePlotFileName,
} from "../core/resumeSheet";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { ChunkCache } from "../core/chunkCache";
import { measureParts } from "../core/usageLog";
import {
  isEpisodePlotWritten,
  parseEpisodePlot,
  type EpisodePlotDoc,
} from "../core/episodePlotDoc";
import {
  describeEpisodePlotRejects,
  parseEpisodePlotFindings,
  validateEpisodePlotCheck,
  validateEpisodePlotContrast,
  type EpisodePlotContrastFinding,
  type EpisodePlotFinding,
} from "../core/episodePlotValidation";
import {
  buildEpisodePlotCheckPrompt,
  episodePlotCheckBudget,
  EPISODE_PLOT_CHECK_SCHEMA,
  EPISODE_PLOT_CHECK_SYSTEM_PROMPT,
  EPISODE_PLOT_CHECK_VERSION,
} from "../prompts/episodePlotCheck";
import {
  buildEpisodePlotContrastPrompt,
  episodePlotContrastBudget,
  EPISODE_PLOT_CONTRAST_SCHEMA,
  EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT,
  EPISODE_PLOT_CONTRAST_VERSION,
} from "../prompts/episodePlotContrast";
import {
  describeChunkSettings,
  readChunkSettings,
  resolveModelInfoOrWarn,
} from "./chunkSettings";
import { confirmProviderReachable } from "./aiConnectivity";
import { withCancellableProgress, type CheckProgress } from "../views/progress";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";

/**
 * 単話プロットのAI判定2種（P-27・P-28、設計書6.36.3）。
 *
 * **どちらも指摘までで、書き直しの作文はさせない。** 単話プロットは
 * 作者が書くもので、AIに筋書きを作らせない（6.36.2の決まりを、判定側でも
 * 守る）。プロンプトに修正案の欄が無く、ここにも適用の口が無い。
 *
 * **プロットも本文も書き換えない。** 読むだけである。
 *
 * **箇条書きが空なら実行しない。** 照らし合わせる相手が無いのに問うと、
 * AIは無いものから「緩んでいそうなこと」を作り出す（プロットが無いまま
 * 逸脱検知を掛けさせないのと同じ理由。設計書6.10.2）。
 *
 * 機能別AI割当は `deviation`（プロットからの逸脱）に相乗りする。作者から
 * 見て「筋と本文を照らす仕事」は同じ種類で、割当の選択肢だけが増えても
 * 選ぶ手間が増える（設計書6.28.9の考え方）。
 */

/**
 * コマンド `novelai.checkEpisodePlot` の引数。
 *
 * **プロットモードのパネル（6.4.8）は、どの話のどちらを掛けるかを
 * 既に知っている。** 押したあとに「どの話ですか」と訊き返すのは、
 * 同じことを2度聞くことになる（`createEpisodePlot` と同じ判断）。
 */
export interface EpisodePlotCheckRef {
  type: "episodePlot";
  work: WorkEntry;
  chapter: number;
  check: EpisodePlotCheckAction;
}

export interface EpisodePlotRunBase {
  /** その話の見出し（「第3話」） */
  chapterLabel: string;
  /** 単話プロットの場所（指摘から開く先） */
  plotPath: string;
  /** 捨てた件数と、その内訳。**黙って減らさない** */
  rejectedCount: number;
  rejectSummary: string;
  /** 応答を読み取れなかったか（0件と区別する） */
  failed: boolean;
  cancelled: boolean;
  /** 書かれていない節の名前。判定の効き目に関わるので作者へ伝える */
  blanks: string[];
}

export interface EpisodePlotDesignResult extends EpisodePlotRunBase {
  findings: EpisodePlotFinding[];
}

export interface EpisodePlotContrastResult extends EpisodePlotRunBase {
  findings: EpisodePlotContrastFinding[];
  /** 照らした本文のファイル */
  episodePath: string;
  /**
   * 長さの上限で切り落とした字数（0なら切っていない）。
   *
   * **切ったことを隠さない。** 切った後ろは見ていないので、
   * 「指摘0件」を「食い違いが無い」と読まれては困る。
   */
  droppedChars: number;
}

export interface CheckEpisodePlotOptions {
  /** 進み具合の届け先（提案パネルへ出す）。渡されなければ何もしない */
  onProgress?: CheckProgress;
}

// ── どの話の、どちらを掛けるか ────────────────────

/**
 * 話数と種別を決める（設計書6.36.3）。
 *
 * 詳細メニュー・右クリックからは「どの話か」も「どちらの判定か」も
 * 分からないので、ここで決める。**分かっているものは訊き返さない。**
 *
 * @param preset 呼び出し側が既に知っているもの（開いているファイルの話数など）
 */
export async function pickEpisodePlotTarget(
  work: WorkEntry,
  preset: { chapter?: number; check?: EpisodePlotCheckAction } = {}
): Promise<{ chapter: number; check: EpisodePlotCheckAction } | undefined> {
  const chapter = preset.chapter ?? (await pickChapter(work));
  if (chapter === undefined) return undefined;

  if (preset.check) return { chapter, check: preset.check };

  const available = await availableChecks(work, chapter);
  if (available.length === 1) return { chapter, check: available[0] };

  const picked = await vscode.window.showQuickPick(
    [
      ...available.map((check) => ({
        label: EPISODE_PLOT_CHECK_LABELS[check].label,
        detail: EPISODE_PLOT_CHECK_LABELS[check].detail,
        check,
      })),
      cancelItem(),
    ],
    { title: `第${chapter}話の単話プロットに、何を掛けますか`, ignoreFocusOut: true }
  );
  if (!picked || isCancelItem(picked) || !("check" in picked)) return undefined;
  return { chapter, check: picked.check };
}

/**
 * 掛けられる判定。
 *
 * **本文が無い話に「本文と照合」を出さない**（プロットモードの一覧と
 * 同じ判断。判定そのものは `episodePlotChecksFor` が持つ）。
 */
async function availableChecks(
  work: WorkEntry,
  chapter: number
): Promise<EpisodePlotCheckAction[]> {
  try {
    const { episodes } = await scanWork(work);
    const episode = episodes.find(
      (entry) => episodePlotChapterOf(entry) === chapter
    );
    return episodePlotChecksFor({
      // ここへ来る時点で単話プロットの有無は確かめてある
      hasEpisodePlot: true,
      hasManuscript: (episode?.counts.net ?? 0) > 0,
      conflicted: episode?.hasConflictMarkers ?? false,
    });
  } catch {
    // 走査に失敗しても、設計の検査だけはプロットがあれば掛けられる
    return ["design"];
  }
}

/**
 * 単話プロットのある話を選ばせる。
 *
 * **無い話は並べない。** 選んでから「ありません」と言われるのでは、
 * 選ばせた意味が無い。
 */
async function pickChapter(work: WorkEntry): Promise<number | undefined> {
  const config = await readWorkConfig(work);
  const directory = path.join(
    workPaths(work, config).settings,
    EPISODE_PLOTS_DIR
  );

  let chapters: number[] = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(
      path.toUri(directory)
    );
    chapters = entries
      .map(([name]) => episodePlotChapterFromFileName(name))
      .filter((chapter): chapter is number => chapter !== null)
      .sort((left, right) => right - left);
  } catch {
    // 置き場がまだ無いのは普通のこと（1つも作っていない作品）
  }

  if (chapters.length === 0) {
    const answer = await vscode.window.showInformationMessage(
      "単話プロットがまだ1つもありません。",
      { modal: true, detail: "先に「単話プロットを作る」で、視点・目標・展開を書いてください。" },
      "単話プロットを作る"
    );
    if (answer === "単話プロットを作る") {
      await vscode.commands.executeCommand("novelai.createEpisodePlot", {
        type: "work",
        work,
      });
    }
    return undefined;
  }
  if (chapters.length === 1) return chapters[0];

  const picked = await vscode.window.showQuickPick(
    [
      ...chapters.map((chapter, index) => ({
        label: `第${chapter}話`,
        // 並びは新しい順。既定（先頭）がどれかを分かるようにする
        description: index === 0 ? "いちばん新しい" : undefined,
        chapter,
      })),
      cancelItem(),
    ],
    { title: "どの話の単話プロットを見ますか", ignoreFocusOut: true }
  );
  if (!picked || isCancelItem(picked) || !("chapter" in picked)) {
    return undefined;
  }
  return picked.chapter;
}

// ── P-27 設計の検査 ──────────────────────────────

export async function checkEpisodePlotDesign(
  work: WorkEntry,
  chapter: number,
  registry: AIRegistry,
  options: CheckEpisodePlotOptions = {}
): Promise<EpisodePlotDesignResult | undefined> {
  useLogFile(work.folderPath);

  const loaded = await loadEpisodePlot(work, chapter);
  if (!loaded) return undefined;
  const { doc, plotPath, plotText } = loaded;

  const resolved = await ensureConfigured(registry, "deviation");
  if (!resolved) return undefined;

  const chapterLabel = await labelOf(work, chapter);
  const maxFindings = episodePlotCheckBudget(doc.items.length);
  const userPrompt = buildEpisodePlotCheckPrompt({
    chapterLabel,
    viewpoint: doc.viewpoint,
    goal: doc.goal,
    items: doc.items.map((item) => item.text),
    maxFindings,
  });

  const cache = new ChunkCache(work);
  await cache.load();
  const cacheKeyBase = {
    feature: "episode_plot_check",
    promptVersion: EPISODE_PLOT_CHECK_VERSION,
    providerId: resolved.provider.id,
    model: resolved.model,
  };
  // **鍵は書いた中身そのもの。** プロットを直せば答えも変わる
  const hash = hashText(plotText);
  const cached = cache.get(hash, cacheKeyBase);

  if (!cached) {
    if (
      !(await confirmProviderReachable(
        resolved.provider,
        "単話プロットの検査",
        resolved.model
      ))
    ) {
      return undefined;
    }
    const confirm = await vscode.window.showInformationMessage(
      `${chapterLabel}の単話プロットを検査します。`,
      {
        modal: true,
        detail: [
          `展開の箇条書き ${doc.items.length}件を送ります（本文は送りません）。`,
          "",
          "プロットは書き換えません。 気になるところを並べるだけで、",
          "直し方は書かせません（直すかどうかは作者が決めます）。",
          doc.blanks.length > 0
            ? `\nまだ書かれていない節があります：${doc.blanks.join("・")}`
            : "",
          resolved.provider.isPaid
            ? `\n${resolved.provider.displayName} は1回ぶん課金されます。`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      "実行"
    );
    if (confirm !== "実行") return undefined;
  }

  logStep(
    `単話プロットの検査を開始: ${work.title} / ${chapterLabel} / ` +
      `${resolved.provider.displayName} / ${resolved.model} / ` +
      `箇条書き${doc.items.length}件 / v${EPISODE_PLOT_CHECK_VERSION}`
  );

  const base: EpisodePlotRunBase = {
    chapterLabel,
    plotPath,
    rejectedCount: 0,
    rejectSummary: "",
    failed: false,
    cancelled: false,
    blanks: doc.blanks,
  };
  const findings: EpisodePlotFinding[] = [];

  await withCancellableProgress(
    "単話プロットの展開を見ています",
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => {
        base.cancelled = true;
        controller.abort();
      });

      const raw =
        cached ??
        (await ask({
          provider: resolved.provider,
          model: resolved.model,
          systemPrompt: EPISODE_PLOT_CHECK_SYSTEM_PROMPT,
          userPrompt,
          schema: EPISODE_PLOT_CHECK_SCHEMA as unknown as object,
          feature: "episode_plot_check",
          workFolder: work.folderPath,
          label: "単話プロットの検査",
          chapterLabel,
          parts: { 箇条書き: userPrompt.length },
          // 送るのは箇条書きだけで小さいが、**照合側と同じ扱いにする**
          // （設計書6.77の第2段）。同じ機能の2つの呼び出しで扱いが違うと、
          // 片方だけ直したときに気づけない
          maxOutputTokens: resolveOutputTokensForSend(
            resolved.provider.id,
            resolved.model
          ),
          plannedOutputTokens: resolveOutputTokensForPlanning(
            resolved.provider.id,
            resolved.model
          ),
          signal: controller.signal,
        }));
      progress.report({ message: "1/1", increment: 100 });
      options.onProgress?.(1, 1);

      if (raw === undefined) {
        base.failed = !base.cancelled;
        return;
      }
      if (!cached) await cache.set(hash, cacheKeyBase, raw);

      const validated = validateEpisodePlotCheck(raw, {
        items: doc.items,
        maxFindings,
      });
      base.rejectedCount = validated.rejected.length;
      base.rejectSummary = describeEpisodePlotRejects(validated.rejected);
      findings.push(...validated.accepted);
    }
  );

  await cache.save();
  return { ...base, findings };
}

// ── P-28 本文との照合 ────────────────────────────

export async function contrastEpisodePlot(
  work: WorkEntry,
  chapter: number,
  registry: AIRegistry,
  options: CheckEpisodePlotOptions = {}
): Promise<EpisodePlotContrastResult | undefined> {
  useLogFile(work.folderPath);

  const loaded = await loadEpisodePlot(work, chapter);
  if (!loaded) return undefined;
  const { doc, plotPath, plotText } = loaded;

  const episode = await findEpisode(work, chapter);
  if (!episode) return undefined;

  const resolved = await ensureConfigured(registry, "deviation");
  if (!resolved) return undefined;

  // **取れなければ止める**（設計書6.27.10）。既定値へ黙って落ちると、
  // 本文の切り落とし方が変わってキャッシュが総入れ替えになる
  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "deviation",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "単話プロットと本文の照合",
  });
  if (!info) return undefined;

  const chapterLabel = await labelOf(work, chapter);
  const maxFindings = episodePlotContrastBudget(doc.items.length);
  const items = doc.items.map((item) => item.text);

  // **本文を空にしてプロンプトを組み、その字数を固定費とする**
  // （設計書6.27.10）。箇条書きが増えれば、そのぶん本文を痩せさせる
  const overheadChars =
    EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT.length +
    buildEpisodePlotContrastPrompt({
      chapterLabel,
      goal: doc.goal,
      items,
      chapterText: "",
      maxFindings,
    }).length;
  const outputTuning = {
    providerId: resolved.provider.id,
    model: resolved.model,
  };
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    outputTuning.providerId,
    outputTuning.model
  );
  // **場所の確保（上）と、実際に送る上限（下）は別物である**（設計書6.77の
  // 第2段）。上を上限として送ると、測っていないモデルでは上限が設定値の
  // 半分になり、長い応答が途中で切れる
  const sendOutputTokens = resolveOutputTokensForSend(
    outputTuning.providerId,
    outputTuning.model
  );
  const chunkSettings = readChunkSettings(
    info.contextWindow,
    { overheadChars, outputTokens: plannedOutputTokens },
    outputTuning
  );

  /*
    **チャンクへ割らない。** 「箇条書きの順に起きているか」は話を
    ひとつながりで見ないと判断できない（P-11が話単位で見るのと同じ）。
    入り切らない長い話は後ろを落とし、**落としたことを作者へ伝える。**
  */
  const whole = blankMemoLines(episode.text);
  const body = whole.slice(0, chunkSettings.chunk.chars);
  const droppedChars = whole.length - body.length;

  const userPrompt = buildEpisodePlotContrastPrompt({
    chapterLabel,
    goal: doc.goal,
    items,
    chapterText: body,
    maxFindings,
  });

  const cache = new ChunkCache(work);
  await cache.load();
  // **箇条書きが変われば、同じ本文でも答えが変わる**（逸脱検知が
  // プロットの指紋を鍵へ入れるのと同じ）
  const cacheKeyBase = {
    feature: "episode_plot_contrast",
    promptVersion: `${EPISODE_PLOT_CONTRAST_VERSION}:${hashText(plotText).slice(0, 16)}`,
    providerId: resolved.provider.id,
    model: resolved.model,
  };
  const hash = hashText(body);
  const cached = cache.get(hash, cacheKeyBase);

  if (!cached) {
    if (
      !(await confirmProviderReachable(
        resolved.provider,
        "単話プロットと本文の照合",
        resolved.model
      ))
    ) {
      return undefined;
    }
    const confirm = await vscode.window.showInformationMessage(
      `${chapterLabel}の本文と、単話プロットを照らし合わせます。`,
      {
        modal: true,
        detail: [
          `本文 ${body.length}字と、展開の箇条書き ${items.length}件を送ります。`,
          droppedChars > 0
            ? `この話は長いため、後ろの ${droppedChars}字は送りません。`
            : "",
          "",
          "本文もプロットも書き換えません。 食い違いを並べるだけで、",
          "箇条書きのほうが古いこともあります。",
          resolved.provider.isPaid
            ? `\n${resolved.provider.displayName} は1回ぶん課金されます。`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      "実行"
    );
    if (confirm !== "実行") return undefined;
  }

  logStep(
    `単話プロットと本文の照合を開始: ${work.title} / ${chapterLabel} / ` +
      `${resolved.provider.displayName} / ${resolved.model} / ` +
      `本文${body.length}字（落とした${droppedChars}字） / ` +
      `${describeChunkSettings(chunkSettings)} / v${EPISODE_PLOT_CONTRAST_VERSION}`
  );

  const base: EpisodePlotRunBase = {
    chapterLabel,
    plotPath,
    rejectedCount: 0,
    rejectSummary: "",
    failed: false,
    cancelled: false,
    blanks: doc.blanks,
  };
  const findings: EpisodePlotContrastFinding[] = [];

  await withCancellableProgress(
    "本文と単話プロットを照らしています",
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => {
        base.cancelled = true;
        controller.abort();
      });

      const raw =
        cached ??
        (await ask({
          provider: resolved.provider,
          model: resolved.model,
          systemPrompt: EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT,
          userPrompt,
          schema: EPISODE_PLOT_CONTRAST_SCHEMA as unknown as object,
          feature: "episode_plot_contrast",
          workFolder: work.folderPath,
          label: "単話プロットと本文の照合",
          chapterLabel,
          parts: { 本文: body.length, 箇条書き: items.join("").length },
          maxOutputTokens: sendOutputTokens,
          plannedOutputTokens,
          signal: controller.signal,
        }));
      progress.report({ message: "1/1", increment: 100 });
      options.onProgress?.(1, 1);

      if (raw === undefined) {
        base.failed = !base.cancelled;
        return;
      }
      if (!cached) await cache.set(hash, cacheKeyBase, raw);

      const validated = validateEpisodePlotContrast(raw, {
        items: doc.items,
        text: body,
        maxFindings,
      });
      base.rejectedCount = validated.rejected.length;
      base.rejectSummary = describeEpisodePlotRejects(validated.rejected);
      findings.push(...validated.accepted);
    }
  );

  await cache.save();
  return {
    ...base,
    findings,
    episodePath: episode.filePath,
    droppedChars,
  };
}

// ── 共通の下ごしらえ ─────────────────────────────

interface LoadedEpisodePlot {
  doc: EpisodePlotDoc;
  plotPath: string;
  /** ファイルの中身そのまま（キャッシュの鍵に使う） */
  plotText: string;
}

/**
 * 単話プロットを読む。
 *
 * **中身が空なら実行しない。** 雛形のままの問いかけを渡しても、照らし
 * 合わせる相手にはならない（逸脱検知が空のプロットを断るのと同じ）。
 * 無ければ「作りますか」まで案内する——押した作者は、次に何をすれば
 * よいかを知りたいはずである。
 */
async function loadEpisodePlot(
  work: WorkEntry,
  chapter: number
): Promise<LoadedEpisodePlot | undefined> {
  const config = await readWorkConfig(work);
  const plotPath = path.join(
    workPaths(work, config).settings,
    EPISODE_PLOTS_DIR,
    episodePlotFileName(chapter)
  );

  if (!(await pathExists(plotPath))) {
    const answer = await vscode.window.showWarningMessage(
      `第${chapter}話の単話プロットがまだありません。`,
      {
        modal: true,
        detail:
          "この機能は、作者が書いた「視点・目標・展開」を材料にします。" +
          "無いまま実行すると、AIは何も無いところから" +
          "「緩んでいそうなこと」を作り出します。",
      },
      "単話プロットを作る"
    );
    if (answer === "単話プロットを作る") {
      await vscode.commands.executeCommand("novelai.createEpisodePlot", {
        type: "work",
        work,
      });
    }
    return undefined;
  }

  let plotText: string;
  try {
    plotText = (await readTextFile(plotPath)).text;
  } catch (error) {
    logFailure("単話プロットの読み込み", {
      ファイル: plotPath,
      詳細: messageOf(error),
    });
    void vscode.window.showErrorMessage(
      `単話プロットを読めませんでした：${messageOf(error)}`
    );
    return undefined;
  }

  const doc = parseEpisodePlot(plotText);
  if (!isEpisodePlotWritten(doc)) {
    void vscode.window.showWarningMessage(
      `第${chapter}話の単話プロットに、展開がまだ書かれていません。` +
        "「展開（箇条書き）」を書いてから実行してください。",
      { modal: true }
    );
    return undefined;
  }

  return { doc, plotPath, plotText };
}

interface LoadedEpisode {
  filePath: string;
  text: string;
}

/**
 * その話の本文。
 *
 * **競合の跡が残るファイルは触らない**（この作品の決まり）。白紙の話も
 * 照らす相手にならないので、その旨を出して止める。
 */
async function findEpisode(
  work: WorkEntry,
  chapter: number
): Promise<LoadedEpisode | undefined> {
  const { episodes } = await scanWork(work);
  const episode = episodes.find(
    (entry) => episodePlotChapterOf(entry) === chapter
  );
  if (!episode) {
    void vscode.window.showWarningMessage(
      `第${chapter}話の本文が見つかりませんでした。書いてから実行してください。`
    );
    return undefined;
  }
  if (episode.hasConflictMarkers) {
    void vscode.window.showWarningMessage(
      `${episode.fileName} に同期の競合の跡が残っています。` +
        "先に競合を解消してください。"
    );
    return undefined;
  }

  try {
    const text = (await readTextFile(episode.filePath)).text;
    if (!text.trim()) {
      void vscode.window.showWarningMessage(
        `第${chapter}話はまだ白紙です。書いてから実行してください。`
      );
      return undefined;
    }
    return { filePath: episode.filePath, text };
  } catch (error) {
    logFailure("単話プロットと本文の照合：本文の読み込み", {
      ファイル: episode.filePath,
      詳細: messageOf(error),
    });
    void vscode.window.showErrorMessage(
      `本文を読めませんでした：${messageOf(error)}`
    );
    return undefined;
  }
}

/** その話の見出し。作品の形式に従う（「第3話」「投稿2026-08-16」） */
async function labelOf(work: WorkEntry, chapter: number): Promise<string> {
  try {
    const format = await readWorkFormat(work);
    const { episodes } = await scanWork(work);
    const episode = episodes.find(
      (entry) => episodePlotChapterOf(entry) === chapter
    );
    const label = episode ? formatChapterLabel(episode, format) : "";
    if (label) return label;
  } catch {
    // 走査に失敗しても判定はできる。見出しが素っ気なくなるだけ
  }
  return `第${chapter}話`;
}

/**
 * 1回だけ問い合わせる。
 *
 * **失敗を握りつぶさない。** 読み取れなかった応答も、例外も、理由を
 * ログへ残してから `undefined` を返す（呼び出し側が「0件」と区別する）。
 */
async function ask(options: {
  provider: AIProvider;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema: object;
  feature: string;
  workFolder: string;
  label: string;
  chapterLabel: string;
  parts: Record<string, number>;
  /** 実際に送る出力上限（設計書6.77の第2段） */
  maxOutputTokens?: number;
  /** 場所の確保に見込む量。**上限としては送らない**（同上） */
  plannedOutputTokens?: number;
  signal: AbortSignal;
}): Promise<unknown | undefined> {
  try {
    const response = await options.provider.generate({
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      model: options.model,
      // 判断を伴うので、事実の突き合わせより少しだけ揺らす（P-11と同じ）
      temperature: 0.2,
      // **未指定なら欄ごと落とす。** `undefined` を明示的に渡すと、
      // プロバイダ側の `?? 既定` が効かなくなる書き方が混ざりうる
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.plannedOutputTokens === undefined
        ? {}
        : { plannedOutputTokens: options.plannedOutputTokens }),
      jsonSchema: options.schema,
      disableThinking: true,
      signal: options.signal,
      meta: {
        feature: options.feature,
        workFolder: options.workFolder,
        parts: measureParts(options.userPrompt, options.parts),
      },
    });

    const parsed = parseEpisodePlotFindings(response.text);
    if (!parsed) {
      logFailure(options.label, {
        話: options.chapterLabel,
        理由: response.truncated
          ? "応答が上限で切り詰められました"
          : "応答を読み取れません",
        応答: responseExcerptForLog(response.text),
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (error instanceof AIError && error.kind === "aborted") return undefined;
    logFailure(options.label, {
      話: options.chapterLabel,
      詳細:
        error instanceof AIError
          ? `${error.message} ${recoveryForAIError(error)}`
          : messageOf(error),
    });
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
