import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { scanWork } from "../core/scanner";
import { readTextFile, hashText } from "../core/textFile";
import { blankMemoLines } from "../core/sceneMemo";
import { ChunkCache } from "../core/chunkCache";
import { measureParts } from "../core/usageLog";
import {
  capabilityCacheTag,
  capabilityProfile,
  describeCapability,
} from "../ai/capability";
import { SynopsisStore } from "../core/synopsisStore";
import { referenceBudgetChars } from "../core/sizeBudget";
import { readPlotText } from "../core/plotFile";
import { isBlankPlotSection, parsePlotMarkdown } from "../core/plotDoc";
import { formatChapterLabel } from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import {
  buildDeviationCheckPrompt,
  deviationBudget,
  DEVIATION_CHECK_SCHEMA,
  DEVIATION_CHECK_SYSTEM_PROMPT,
  DEVIATION_CHECK_VERSION,
  DEVIATION_TYPES,
  LIGHT_DEVIATION_TYPES,
  type DeviationType,
} from "../prompts/deviationCheck";
import {
  parseDeviationResult,
  sortDeviations,
  validateDeviations,
  type AcceptedDeviation,
} from "../core/deviationValidation";
import { type CheckProgress } from "../views/progress";
import type { SuiteAwareOptions } from "../core/proofreadingSuite";
import { withAiTurnProgress } from "./aiTurn";
import { confirmProviderReachable } from "./aiConnectivity";
import { confirmFormatFit } from "./formatFitPrompt";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";

/**
 * プロット逸脱・間延び検知（P-11、設計書6.10.2）。
 *
 * **話ごとに見る。** チャンクへ割ると、切れ目の前後がどちらも
 * 「進んでいない」ように見え、間延びの判定が壊れる。
 *
 * **本文は書き換えない。** 逸脱は「プロットと違う」であって
 * 「間違い」ではない。**プロットのほうが古いこともある**（矛盾検知と同じ）。
 *
 * **プロットが無ければ実行しない。** 照らし合わせる相手が無いのに問うと、
 * AIは本文だけを見て「逸脱していそうなこと」を作り出す。
 */

export interface DeviationIssue extends AcceptedDeviation {
  filePath: string;
  chunkHash: string;
}

export interface DeviationRunResult {
  issues: DeviationIssue[];
  rejectedCount: number;
  /** 照らした先がプロットに無かった件数（作者へ伝える価値がある） */
  ungroundedCount: number;
  failedChunks: number;
  /**
   * **本文そのものを読めなかった話の数**（AIへ渡せていない。ログに詳細）。
   *
   * **黙って落とさない。** 文字コードの壊れた話やロックされた話が1つあると、
   * その話だけ検知の対象から抜けるのに、作者には「その話には何も無い」と
   * 見える。
   */
  unreadableEpisodes: number;
  /**
   * プロットを切って送ったときの案内（切らなかったときは undefined）。
   *
   * **黙って切らない。** プロットの末尾を落として問うているのに、
   * 作者からは「その部分については何も指摘が無かった」と見える。
   * 完了報告に**一度だけ**出す（話ごとに繰り返さない）。
   */
  plotTrimmedNote?: string;
  cancelled: boolean;
}

/** 1回で渡す本文の上限。長い話はここで切る */
const MAX_CHAPTER_CHARS = 12_000;

/**
 * プロットにまわしてよい、モデルの上限に対する割合と、固定の頭打ち
 * （設計書6.77の第2段、6.27.4）。
 *
 * **世界観と同じ扱いにする**——プロットも「参照資料」であり、逸脱検知に
 * とっては最重要の資料なので、資料の中では最大の枠（25%・30,000字）を与える。
 * 世界観（`worldviewSelect.ts`）と値を揃えてあるが、**寄せない**——
 * どれだけまわしてよいかは用途ごとの判断であり、片方の都合でもう片方が
 * 動くのを避ける（`sizeBudget.ts` が寄せるのは式だけ）。
 *
 * **ここだけ上限が無かった。** プロットは話の数だけ繰り返し送られるので、
 * 長いプロットの作品では、送る量が話数ぶんに膨らむ。
 */
const PLOT_CONTEXT_RATIO = 0.25;
export const PLOT_MAX_CHARS = 30_000;

/**
 * そのモデルでプロットに使ってよい字数。
 *
 * 131,072のモデルなら22,937字、8,192なら1,433字。固定字数だけだと、
 * モデルを小さいものに替えたときにそのまま溢れる（設計書6.27.10の穴2）。
 */
export function plotMaxChars(contextWindow: number | undefined): number {
  return referenceBudgetChars(
    contextWindow,
    PLOT_CONTEXT_RATIO,
    PLOT_MAX_CHARS
  );
}

/**
 * プロットを上限まで切る。
 *
 * **切るのは末尾から**（＝残すのは先頭）。プロットは冒頭に設定・あらすじの
 * 骨子が来る書式（`plotTemplate.ts`）で、末尾ほど細部になる。逸脱の判定に
 * 効くのは骨格のほうである。
 *
 * **行の途中では切らない。** 切れ端の一行が残ると、AIはそれを完結した
 * 一文として読み、書かれていない筋を読み取る。最後の改行まで戻す。
 * ただし改行が一つも無いプロットでは戻れないので、そのときは素直に
 * 上限で切る（空を返すと、照らし合わせる相手が消える）。
 *
 * **上限内なら1バイトも変えない。** ここが1文字でも変わると、大多数の
 * 作品で送る内容が変わってしまう。
 */
export function trimPlotForDeviation(
  plot: string,
  maxChars: number
): { text: string; trimmed: boolean } {
  if (plot.length <= maxChars) return { text: plot, trimmed: false };
  const head = plot.slice(0, maxChars);
  const lastBreak = head.lastIndexOf("\n");
  return {
    text: lastBreak > 0 ? head.slice(0, lastBreak) : head,
    trimmed: true,
  };
}

/** 切ったことを伝える一文（完了報告とログで同じ言い方をする） */
export function describePlotTrim(
  usedChars: number,
  totalChars: number
): string {
  return (
    `プロットが長いため先頭 ${usedChars.toLocaleString("ja-JP")}字だけを使いました` +
    `（全体 ${totalChars.toLocaleString("ja-JP")}字）`
  );
}

export interface CheckDeviationsOptions extends SuiteAwareOptions {
  /**
   * 進み具合の届け先（作者の報告、2026-08-29）。
   *
   * **この検知は話ごとに送る。** 数えているのはチャンクではなく話数なので、
   * 出す側（`extension.ts`）は単位を「話」にする
   */
  onProgress?: CheckProgress;
}

export async function checkDeviations(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckDeviationsOptions = {}
): Promise<DeviationRunResult | undefined> {
  useLogFile(work.folderPath);

  // 短編集・SNS記事では、話が続かないので「プロットからの逸脱」が成り立たない
  if (!(await confirmFormatFit(work, "plotReverse"))) return undefined;

  const plot = await loadPlot(work, options);
  if (!plot) return undefined;

  const resolved = await ensureConfigured(registry, "deviation");
  if (!resolved) return undefined;

  const { episodes, unreadableEpisodes } = await collectEpisodes(work);
  if (episodes.length === 0) {
    vscode.window.showWarningMessage("検知できる本文がありませんでした。");
    return undefined;
  }

  const synopses = await loadSynopses(work);

  // 地力の足りないモデルでは種別を絞り、実行前に断る（設計書6.28）。
  // **この機能は話単位で送るので、コンテキスト長は要らない。**
  // モデル情報が取れなくても止めず、これまでと同じ判定へ落とす
  const modelInfo = await registry.resolveModelInfo("deviation");
  const capability = capabilityProfile({
    tier: modelInfo?.tier,
    providerId: resolved.provider.id,
  });

  // **プロットにも上限を置く**（設計書6.77の第2段）。プロットは話の数だけ
  // 繰り返し送られるので、ここだけ無上限だと長いプロットの作品で送る量が
  // 跳ね上がる。**話ごとの送信の外で一度だけ切る**——中で切ると、同じ案内を
  // 話数ぶん出すことになる
  const plotBudget = plotMaxChars(modelInfo?.contextWindow);
  const plotTrim = trimPlotForDeviation(plot, plotBudget);
  const plotText = plotTrim.text;
  const plotTrimmedNote = plotTrim.trimmed
    ? describePlotTrim(plotText.length, plot.length)
    : undefined;
  if (plotTrimmedNote) logStep(`プロット逸脱検知：${plotTrimmedNote}`);

  const cache = new ChunkCache(work);
  await cache.load();
  // **プロットが変われば、同じ本文でも答えが変わる。**
  // 含めないと、プロットを直したのに古い指摘が出続ける（矛盾検知と同じ）。
  // **鍵に入れるのは実際に送るほう**（切ったあと）である。全文で鍵を作ると、
  // モデルを小さいものに替えて送る量が変わったのに、前の答えを使い回す
  const cacheKeyBase = {
    feature: "deviation_check",
    // 見る種別が変われば答えも変わるので、鍵にも入れる。絞らないときは
    // 印が空になるので、`high` のモデルの鍵はこれまでと同じままになる
    promptVersion:
      `${DEVIATION_CHECK_VERSION}:` +
      `${capabilityCacheTag(capability)}${hashText(plotText).slice(0, 16)}`,
    providerId: resolved.provider.id,
    model: resolved.model,
  };

  const pending = episodes.filter(
    (episode) => !cache.get(episode.hash, cacheKeyBase)
  );
  if (pending.length > 0) {
    // **モデル名を渡す。** LM Studioをこの場から起こしたとき、
    // 起こした直後に読み込ませるために要る（`aiConnectivity.ts`）
    if (
      !(await confirmProviderReachable(
        resolved.provider,
        "プロット逸脱の検知",
        resolved.model
      ))
    ) {
      return undefined;
    }
    const detail = [
      `${episodes.length}話中 ${pending.length}話を処理します` +
        `（処理済み ${episodes.length - pending.length}話はスキップ）。`,
      "",
      "本文は書き換えません。 プロットと違う箇所を並べるだけで、",
      "プロットのほうが古いこともあります。",
      // **実測に基づく断り。** 黙って動かして0件を返すより、
      // 先に「効かない」と言うほうがよい（設計書6.10.2）。
      // **「手元の」でも「Ollama」でもなく、地力で言う**——同じことは
      // LM Studio の小さいモデルでも、クラウドの小さいモデルでも起きる
      capability.warnDeviationIneffective
        ? "\n小さめのモデルでは、この機能はほとんど働きません。\n" +
          "実データで5回測ったところ、gemma4:e4b と gemma4:12b は\n" +
          "プロットに載せた話と外した話を見分けられませんでした。\n" +
          "大きなモデル（Claude・ChatGPT・Gemini など）をお使いください。\n" +
          "（このモデルでは「間延び」も見ません。判定が難しく的外れが増えるため）"
        : "",
      // 種別を絞ると鍵が変わり、キャッシュが総入れ替えになる
      pending.length === episodes.length && episodes.length > 1
        ? "\n（見る種別が前回から変わっているため、今回はすべて送り直します）"
        : "",
      resolved.provider.isPaid
        ? `\n${resolved.provider.displayName} は話ごとに課金されます。`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (options.suiteConfirmed) {
      // まとめ実行が先に1回だけ確認している（設計書6.80）。
      // **飛ばした中身はログへ残す**——「小さめのモデルではほとんど働きません」
      // という実測に基づく断りは、この確認の中にしか書かれていない
      logStep(`プロット逸脱検知：まとめ実行のため確認を省略\n${detail}`);
    } else {
      const confirm = await vscode.window.showInformationMessage(
        `${work.title} のプロット逸脱を検知します。`,
        { modal: true, detail },
        "実行"
      );
      if (confirm !== "実行") return undefined;
    }
  }

  logStep(
    `プロット逸脱検知を開始: ${work.title} / ${resolved.provider.displayName} / ` +
      `${resolved.model}（${describeCapability({ tier: modelInfo?.tier, providerId: resolved.provider.id }, capability)}） / ` +
      `${episodes.length}話 / v${DEVIATION_CHECK_VERSION}`
  );

  const types: readonly DeviationType[] = capability.narrowDeviationTypes
    ? LIGHT_DEVIATION_TYPES
    : DEVIATION_TYPES;
  const provider = resolved.provider;
  const model = resolved.model;
  // **応答の見込みに実測を使う**（設計書6.65.16の2、6.77の第2段）。
  // 渡さないと、Ollamaの `num_ctx` が既定の8,192で確保される
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    resolved.provider.id,
    model
  );
  // **場所の確保（上）と、実際に送る上限（下）は別物である**（設計書6.77の
  // 第2段）。上を上限として送ると、測っていないモデルでは上限が設定値の
  // 半分になり、長い応答が途中で切れる
  const sendOutputTokens = resolveOutputTokensForSend(
    resolved.provider.id,
    model
  );

  const issues: DeviationIssue[] = [];
  let rejectedCount = 0;
  let ungroundedCount = 0;
  let failedChunks = 0;
  let cancelled = false;

  // **ほかの一括処理と重ならないよう、実行の札を取る**（設計書6.76）。
  // 関所（送信を1件ずつ）だけだと、機能どうしが交互に流れて
  // モデルの読み込み直しが往復する
  await withAiTurnProgress(
    "プロットとの食い違いを見ています",
    {
      label: "プロットからの逸脱の検知",
      onCancelled: () => (cancelled = true),
    },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => {
        cancelled = true;
        controller.abort();
      });

      let done = 0;
      for (const episode of episodes) {
        if (token.isCancellationRequested) break;

        const cached = cache.get(episode.hash, cacheKeyBase);
        const raw = cached ?? (await ask(episode));
        done++;
        progress.report({
          message: `${done}/${episodes.length}`,
          increment: 100 / episodes.length,
        });
        // 提案パネルにも同じ進みを出す（作者は結果が出る場所で待っている）
        options.onProgress?.(done, episodes.length);
        if (raw === undefined) continue;

        const validated = validateDeviations(raw, {
          text: episode.text,
          // **照らすのは「送ったプロット」である。** 切り落とした先の一節を
          // 引いた指摘は、AIが見ていない箇所を当てたことになる（＝根拠が無い）
          plot: plotText,
        });
        rejectedCount += validated.rejected.length;
        ungroundedCount += validated.rejected.filter(
          (entry) => entry.reason === "plot_reference_not_found"
        ).length;
        for (const item of validated.accepted) {
          issues.push({
            ...item,
            filePath: episode.filePath,
            chunkHash: episode.hash,
          });
        }
      }

      async function ask(episode: Episode): Promise<unknown | undefined> {
        try {
          const bodyWithLines = withLineNumbers(episode.text);
          const surroundingSynopses = nearbySynopses(synopses, episode.chapter);
          const userPrompt = buildDeviationCheckPrompt({
            chapterLabel: episode.label,
            plot: plotText,
            chapterTextWithLineNumbers: bodyWithLines,
            surroundingSynopses,
            types,
            maxIssues: deviationBudget(episode.text.length),
          });

          const response = await provider.generate({
            systemPrompt: DEVIATION_CHECK_SYSTEM_PROMPT,
            userPrompt,
            model,
            // 判断を伴うので、事実の突き合わせより少しだけ揺らす
            temperature: 0.2,
            maxOutputTokens: sendOutputTokens,
            plannedOutputTokens,
            jsonSchema: DEVIATION_CHECK_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
            meta: {
              feature: "deviation_check",
              workFolder: work.folderPath,
              parts: measureParts(userPrompt, {
                本文: bodyWithLines.length,
                // **プロットは話の数だけ繰り返し送られる。** 長いプロットの
                // 作品ほど効いてくるので、**上限で切ったあとの**実際の量を測る
                プロット: plotText.length,
                あらすじ: surroundingSynopses.length,
              }),
            },
          });

          const parsed = parseDeviationResult(response.text);
          if (!parsed) {
            failedChunks++;
            // **切り詰めと「変な形で返った」を分ける**（設計書6.77の第2段）。
            // 一緒くたにすると、上限が足りないのかAIの気まぐれなのかが
            // 記録から分からず、直しようがない
            logFailure("プロット逸脱検知", {
              話: episode.label,
              理由: response.truncated
                ? "応答が出力上限で切り詰められました"
                : "応答を読み取れません",
              応答: responseExcerptForLog(response.text),
            });
            return undefined;
          }
          await cache.set(episode.hash, cacheKeyBase, parsed);
          return parsed;
        } catch (error) {
          if (error instanceof AIError && error.kind === "aborted") {
            return undefined;
          }
          failedChunks++;
          logFailure("プロット逸脱検知", {
            話: episode.label,
            詳細:
              error instanceof AIError
                ? `${error.message} ${recoveryForAIError(error)}`
                : error instanceof Error
                  ? error.message
                  : String(error),
          });
          return undefined;
        }
      }
    }
  );

  await cache.save();

  return {
    issues: sortDeviations(issues) as DeviationIssue[],
    rejectedCount,
    ungroundedCount,
    failedChunks,
    unreadableEpisodes,
    plotTrimmedNote,
    cancelled,
  };
}

/**
 * プロットを読む。
 *
 * **中身が空なら実行しない。** 見出しだけのテンプレートを渡しても、
 * 照らし合わせる相手にはならない。
 */
async function loadPlot(
  work: WorkEntry,
  /** まとめ実行の印。前提が無いときの伝え方が変わる（設計書6.80） */
  suite: SuiteAwareOptions
): Promise<string | undefined> {
  const text = await readPlotText(work);
  const sections = parsePlotMarkdown(text).sections;
  const written = Object.values(sections).filter(
    (body) => !isBlankPlotSection(body)
  );

  if (written.length === 0) {
    // **まとめ実行では、ここで作者を止めない**（設計書6.80）。プロットが
    // 要るのはこの検知だけなので、残りまで巻き添えで止めない。
    // 理由は最後のまとめへ一言として並べる
    if (suite.suiteConfirmed) {
      suite.noteMissing?.(
        "プロット逸脱は、照らし合わせるプロットがまだ無いため実行しませんでした" +
          "（「プロットをつくる」か「本文からプロットを起こす」で作ってください）。"
      );
      return undefined;
    }
    const answer = await vscode.window.showWarningMessage(
      "照らし合わせるプロットがまだありません。",
      {
        modal: true,
        detail:
          "この機能は、書いたプロットと本文を照らし合わせます。" +
          "プロットが無いまま実行すると、AIは本文だけを見て" +
          "「逸脱していそうなこと」を作り出します。\n\n" +
          "「プロットをつくる」で書くか、「本文からプロットを起こす」で" +
          "作ってから実行してください。",
      },
      "本文からプロットを起こす"
    );
    if (answer === "本文からプロットを起こす") {
      await vscode.commands.executeCommand("novelai.generatePlot", {
        type: "work",
        work,
      });
    }
    return undefined;
  }
  return text;
}

interface Episode {
  filePath: string;
  label: string;
  chapter: number | null;
  text: string;
  hash: string;
}

async function collectEpisodes(
  work: WorkEntry
): Promise<{ episodes: Episode[]; unreadableEpisodes: number }> {
  const scan = await scanWork(work);
  const format = await readWorkFormat(work);
  const out: Episode[] = [];
  let unreadableEpisodes = 0;

  for (const episode of scan.episodes) {
    // 競合マーカーのあるファイルはAI処理をブロックする
    if (episode.hasConflictMarkers) continue;
    let text: string;
    try {
      /*
        **シーンメモはAIへ渡さない**（設計書6.40.2）。逸脱の検知は
        `splitIntoChunks` を通らず、読んだ本文をそのまま送るので、
        ここで落とす。**空行にする**（行ごと落とさない）のは、指摘の
        引用位置が元の本文とずれないようにするためである。
      */
      text = blankMemoLines((await readTextFile(episode.filePath)).text);
    } catch (error) {
      // **記録して数える。** 黙って落とすと、その話は検知の対象から
      // 抜けたのに、作者には「何も無かった」と見える
      unreadableEpisodes++;
      logFailure("プロット逸脱の検知：本文の読み込み", {
        ファイル: episode.filePath,
        詳細: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    // **長い話は切る。** 切ったことは指摘の行番号から分かる
    const body = text.slice(0, MAX_CHAPTER_CHARS);
    out.push({
      filePath: episode.filePath,
      label: formatChapterLabel(episode, format) || episode.fileName,
      chapter: episode.chapterStart,
      text: body,
      hash: hashText(body),
    });
  }
  return { episodes: out, unreadableEpisodes };
}

async function loadSynopses(
  work: WorkEntry
): Promise<Array<{ chapter: number | null; synopsis: string }>> {
  try {
    return (await new SynopsisStore(work).load()).episodes.map((item) => ({
      chapter: item.chapter,
      synopsis: item.synopsis,
    }));
  } catch {
    // あらすじが無くても逸脱は見られる。前後の繋がりが弱くなるだけ
    return [];
  }
}

/**
 * 前後の話のあらすじ。
 *
 * **前後だけにする。** 全部渡すと入力が膨らむうえ、離れた話との
 * 食い違いまで「この話の逸脱」として挙げてくる。
 */
function nearbySynopses(
  synopses: Array<{ chapter: number | null; synopsis: string }>,
  chapter: number | null
): string {
  if (chapter === null) return "";
  return synopses
    .filter(
      (item) =>
        item.chapter !== null && Math.abs(item.chapter - chapter) <= 2
    )
    .map((item) => `第${item.chapter}話: ${item.synopsis}`)
    .join("\n");
}

/** 行番号を振る。`chunker.ts` の同名関数は Chunk 用なのでここに持つ */
function withLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}
