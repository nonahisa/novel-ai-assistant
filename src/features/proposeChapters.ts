import * as vscode from "vscode";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  findChapterStartingAt,
  withChapterStartingAt,
  type Chapter,
  type ChapterSet,
} from "../models/chapter";
import { ChapterStore, ChapterStoreError } from "../core/chapterStore";
import { episodePathFor } from "../core/bookStore";
import { groupEpisodesByChapter } from "../core/chapterGrouping";
import { scanWork } from "../core/scanner";
import { readWorkFormat } from "../core/workFormatStore";
import { formatChapterLabel } from "../core/episodeLabel";
import { SynopsisStore } from "../core/synopsisStore";
import { findSynopsis } from "../models/synopsis";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import type { AIProvider } from "../ai/types";
import { resolveOutputTokensForPlanning } from "../ai/outputLimit";
import { confirmProviderReachable } from "./aiConnectivity";
import {
  describeChunkSettings,
  readChunkSettings,
  resolveModelInfoOrWarn,
} from "./chunkSettings";
import {
  buildChapterProposePrompt,
  CHAPTER_PROPOSE_SCHEMA,
  CHAPTER_PROPOSE_SYSTEM_PROMPT,
  CHAPTER_PROPOSE_VERSION,
  type ChapterProposeEpisode,
} from "../prompts/chapterPropose";
import {
  describeChapterRejectReasons,
  parseChapterProposeResult,
  validateChapterNames,
  validateChapterProposal,
  type ChapterProposalCandidate,
} from "../core/chapterProposalValidation";
import { withCancellableProgress } from "../views/progress";
import { reportAIError } from "./reportAIError";
import { logFailure, logStep, showLog, useLogFile } from "../core/logger";
import { cancelItem, isCancelItem } from "../views/dialogs";
// **型だけを取る。** パネルの実体は呼び出し側（`extension.ts`）が作ったものを
// 受け取るので、ここで束に取り込む必要がない（`checkForeshadows` と同じ）
import type { ProposalPanel, RecordUpdateViewItem } from "./proposalPanel";

/**
 * 章立てのAIの提案（P-31、設計書6.66.4）。
 *
 * **AIは提案するだけ。** 返ってきた章分けは提案パネルに並ぶだけで、
 * 台帳（`設定/章立て.json`）へ入るのは**作者が承認した1件ずつ**である。
 * 保存はすべて `ChapterStore` を通す——外で台帳が変わっていれば止まる。
 *
 * **原稿には一切書き込まない。** 章は台帳の中だけの情報で、本文へ
 * 見出し行を挿し込むようなことはしない（手動の管理と同じ約束）。
 *
 * ## キャッシュは使わない
 *
 * 誤字脱字や伏線の検知は本文をチャンクへ割って何十回も呼ぶので、
 * チャンクキャッシュ（`chunkCache`）が効く。**章立ては作品まるごとで1回**
 * しか呼ばず、しかも作者が「別の案を見たい」と思って押す操作である。
 * 前と同じ答えを返すキャッシュは、その目的をそのまま損なう。
 * 版（`CHAPTER_PROPOSE_VERSION`）はログにだけ残し、再現の手掛かりにする。
 */

/** 出す章名の案の数。**多すぎる選択肢は選べない** */
const NAME_SUGGESTION_LIMIT = 3;

/** 提案パネルに出すときの分類名 */
export const CHAPTER_PROPOSAL_CATEGORY = "章立て";

export interface ProposeChaptersOptions {
  /**
   * 台帳が変わったときに呼ぶ（作品一覧を作り直すため）。
   *
   * **承認はパネルの上で、あとから起きる。** 提案を出した時点では
   * まだ何も変わっていないので、変わった瞬間を知らせる口が要る。
   */
  onChaptersChanged?: () => void;
}

/**
 * 承認された提案を、1件ずつ台帳へ入れる。
 *
 * **`ChapterStore` を1つだけ持ち続ける。** 提案を出したときに読んだ内容を
 * 覚えているので、作者が承認するまでのあいだに外で台帳が変わっていれば、
 * 保存は止まる（設計書6.66.4）。承認のたびに読み直す作りにすると、
 * その外の変更に気づかないまま重ねてしまう。
 */
export class ChapterProposalApplier {
  constructor(
    private readonly store: ChapterStore,
    private set: ChapterSet
  ) {}

  /** いま台帳に入っている章（提案の文言を作るのに使う） */
  get chapters(): readonly Chapter[] {
    return this.set.chapters;
  }

  /**
   * 1件を台帳へ入れる。**既にその話から始まる章があれば改名になる**
   * （手動の「ここから章を始める」と同じ約束、設計書6.66.2）。
   */
  async apply(entry: {
    name: string;
    startEpisodePath: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const next: ChapterSet = {
      ...this.set,
      chapters: withChapterStartingAt(
        this.set.chapters,
        entry.startEpisodePath,
        entry.name
      ),
    };

    try {
      await this.store.save(next);
    } catch (error) {
      const detail = describeError(error);
      logFailure("章立ての提案の反映", {
        章: entry.name,
        開始の話: entry.startEpisodePath,
        種類: error instanceof ChapterStoreError ? error.kind : "unknown",
        詳細: detail,
      });
      return { ok: false, reason: await this.recover(error, detail) };
    }

    // 保存できてから手元を進める。**順序を逆にしない**——失敗した回を
    // 反映済みとして数えると、次の承認が消えた章の上に重なる
    this.set = next;
    return { ok: true };
  }

  /**
   * 外で台帳が変わって止まったときは、**その場で読み直す**（設計書6.66.4）。
   *
   * 読み直さないと、このパネルの承認は**二度と通らない**。手元の
   * `ChapterStore` は古いハッシュを覚えたままなので、作者が何度押しても
   * 同じ理由で止まり、**AIを呼び直す（＝もう一度課金される）以外に道が無い**。
   *
   * **今回の1件は反映しない。** 読み直した内容を見ずに重ねると、外で
   * 加わった章を上書きしうる。次の承認から、新しい内容の上に載る。
   */
  private async recover(error: unknown, detail: string): Promise<string> {
    const kind = error instanceof ChapterStoreError ? error.kind : "unknown";
    if (kind !== "modified_externally") return detail;

    try {
      this.set = await this.store.load();
    } catch (reloadError) {
      logFailure("章立ての提案の反映（読み直し）", {
        内容: describeError(reloadError),
      });
      return detail;
    }
    return `${detail}　最新の章立てを読み直しました。もう一度押すと、その内容の上に反映します。`;
  }
}

/**
 * 提案パネルの1件に並べる説明。
 *
 * **どの話から始まるかを最初に出す。** 章の名前は見出しに出ているので、
 * ここで作者が知りたいのは「どこで切るのか」である。
 */
export function describeChapterProposal(input: {
  /** 開始の話の見出し（「第6話」「投稿3」） */
  label: string;
  reason: string;
  /** 既にその話から始まる章があれば、その名前 */
  existingName?: string;
}): string[] {
  const lines = [`${input.label}から始まります`];
  if (input.existingName) {
    // **黙って書き換わるように見せない。** 承認すると改名になることを、
    // 押す前に伝える
    lines.push(
      `いまは「${input.existingName}」がこの話から始まっています（名前を変えます）`
    );
  }
  if (input.reason) lines.push(`理由：${input.reason}`);
  return lines;
}

/**
 * 章立てをAIに提案させる（作品の右クリック・詳細メニュー）。
 *
 * 材料は**話のサブタイトルと各話あらすじだけ**。本文は送らない。
 */
export async function proposeChapters(
  work: WorkEntry,
  registry: AIRegistry,
  panel: ProposalPanel,
  options: ProposeChaptersOptions = {}
): Promise<void> {
  useLogFile(work.folderPath);

  const material = await collectMaterial(work);
  if (!material) return;
  if (material.episodes.length < 2) {
    vscode.window.showWarningMessage(
      "章に分けられる話がありません（話数の読める話が2つ以上必要です）。"
    );
    return;
  }

  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return;

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "章立ての提案",
      resolved.model
    ))
  ) {
    return;
  }

  const withSynopsis = material.episodes.filter((episode) =>
    episode.synopsis.trim()
  ).length;
  const costNotice = resolved.provider.isPaid
    ? `\n${resolved.provider.displayName} は呼び出すたびに課金されます。`
    : "";
  // **材料が薄いことは、押す前に言う**（設計書6.66.4）。あらすじが無くても
  // サブタイトルだけで動くが、区切りの精度は落ちる
  const materialNotice =
    withSynopsis === 0
      ? "\n各話あらすじがまだありません。サブタイトルだけを材料にするため、区切りの精度は落ちます。"
      : withSynopsis < material.episodes.length
        ? `\nあらすじのある話は ${withSynopsis}/${material.episodes.length} 件です。`
        : "";
  const confirm = await vscode.window.showInformationMessage(
    `${work.title} の章立てを提案します（AIの呼び出しは1回）。\n` +
      `モデル: ${resolved.model}${costNotice}${materialNotice}`,
    "実行",
    "中止"
  );
  if (confirm !== "実行") return;

  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "generate",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "章立ての提案",
  });
  if (!info) return;

  const prompt = buildPromptWithinBudget({
    workTitle: work.title,
    episodes: material.episodes,
    current: material.current,
    providerId: resolved.provider.id,
    model: resolved.model,
    contextWindow: info.contextWindow,
  });
  if (!prompt) {
    vscode.window.showWarningMessage(
      "話が多く、一度に渡せる量を超えました。" +
        "サブタイトルだけにしても入らないため、章立ての提案は行いません。"
    );
    return;
  }

  const text = await callAI({
    provider: resolved.provider,
    model: resolved.model,
    prompt: prompt.text,
    workFolder: work.folderPath,
    title: "章立てを考えています",
  });
  if (!text) return;

  const parsed = parseChapterProposeResult(text);
  if (!parsed) {
    logFailure("章立ての提案", {
      理由: "応答を読み取れません",
      応答: text.slice(0, 400),
    });
    vscode.window
      .showWarningMessage("応答を読み取れませんでした。", "ログを見る")
      .then((answer) => {
        if (answer === "ログを見る") showLog();
      });
    return;
  }

  const { accepted, rejected } = validateChapterProposal(
    parsed,
    material.episodes.map((episode) => episode.number)
  );
  logStep(
    `章立ての提案（P-31 v${CHAPTER_PROPOSE_VERSION}）: 提案 ${accepted.length}件 / ` +
      `捨てた ${rejected.length}件` +
      (rejected.length > 0
        ? `（${describeChapterRejectReasons(rejected)}）`
        : "") +
      `／${prompt.describe}`
  );

  if (accepted.length === 0) {
    vscode.window.showInformationMessage(
      rejected.length > 0
        ? `章立ての提案はありませんでした（${rejected.length}件を検証で捨てました：${describeChapterRejectReasons(rejected)}）。`
        : "章立ての提案はありませんでした。"
    );
    return;
  }

  showChapterProposals(panel, work, material, accepted, options);

  // **捨てた件数を黙らない。** 出た数だけを見せると、AIが出した案の一部が
  // 消えていることに作者は気づけない
  vscode.window.showInformationMessage(
    rejected.length > 0
      ? `章立ての案を ${accepted.length}件 出しました（${rejected.length}件は検証で捨てました）。提案パネルで1件ずつ選べます。`
      : `章立ての案を ${accepted.length}件 出しました。提案パネルで1件ずつ選べます。`
  );
}

/**
 * この章の名前の案を出す（章ノードの右クリック、設計書6.66.4）。
 *
 * **同じP-31に、その章の範囲だけを渡す。** 区切りは動かさない。
 * 返った名前を選択肢に出し、選んだ1つを改名として台帳へ入れる。
 *
 * @returns 台帳を書き換えたか（呼ぶ側が作品一覧を作り直すのに使う）
 */
export async function suggestChapterName(
  work: WorkEntry,
  chapter: Chapter,
  registry: AIRegistry
): Promise<boolean> {
  useLogFile(work.folderPath);

  const material = await collectMaterial(work);
  if (!material) return false;

  const range = material.episodes.filter((episode) =>
    material.rangeOf(chapter).has(episode.number)
  );
  if (range.length === 0) {
    vscode.window.showWarningMessage(
      `章「${chapter.name}」に入る話が見つかりません。` +
        "作品一覧を更新してからお試しください。"
    );
    return false;
  }

  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return false;

  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "章名の提案",
      resolved.model
    ))
  ) {
    return false;
  }

  const costNotice = resolved.provider.isPaid
    ? `\n${resolved.provider.displayName} は呼び出すたびに課金されます。`
    : "";
  const confirm = await vscode.window.showInformationMessage(
    `章「${chapter.name}」の名前の案を出します（AIの呼び出しは1回）。\n` +
      `対象は ${range.length}話。モデル: ${resolved.model}${costNotice}`,
    "実行",
    "中止"
  );
  if (confirm !== "実行") return false;

  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "generate",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "章名の提案",
  });
  if (!info) return false;

  const prompt = buildPromptWithinBudget({
    workTitle: work.title,
    episodes: range,
    current: [{ name: chapter.name, startEpisode: range[0].number }],
    providerId: resolved.provider.id,
    model: resolved.model,
    contextWindow: info.contextWindow,
    nameOnly: { maxSuggestions: NAME_SUGGESTION_LIMIT },
  });
  if (!prompt) {
    vscode.window.showWarningMessage(
      "この章に入る話が多く、一度に渡せる量を超えました。"
    );
    return false;
  }

  const text = await callAI({
    provider: resolved.provider,
    model: resolved.model,
    prompt: prompt.text,
    workFolder: work.folderPath,
    title: "章の名前を考えています",
  });
  if (!text) return false;

  const parsed = parseChapterProposeResult(text);
  const { names, rejected } = parsed
    ? validateChapterNames(
        parsed,
        range.map((episode) => episode.number),
        NAME_SUGGESTION_LIMIT
      )
    : { names: [], rejected: [] };

  logStep(
    `章名の提案（P-31 v${CHAPTER_PROPOSE_VERSION}）: 案 ${names.length}件 / ` +
      `捨てた ${rejected.length}件` +
      (rejected.length > 0
        ? `（${describeChapterRejectReasons(rejected)}）`
        : "")
  );

  if (names.length === 0) {
    if (!parsed) {
      logFailure("章名の提案", {
        理由: "応答を読み取れません",
        応答: text.slice(0, 400),
      });
    }
    vscode.window
      .showWarningMessage("名前の案が得られませんでした。", "ログを見る")
      .then((answer) => {
        if (answer === "ログを見る") showLog();
      });
    return false;
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...names.map((name) => ({
        label: name,
        // いまの名前と同じ案が返ることがある。押しても何も変わらないので断る
        description: name === chapter.name ? "いまと同じ名前です" : undefined,
        name,
      })),
      cancelItem(),
    ],
    {
      title: `章「${chapter.name}」の名前`,
      placeHolder: "採用する名前を選んでください（選ぶまで台帳は変わりません）",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("name" in picked)) return false;
  if (picked.name === chapter.name) return false;

  // **書き込みの直前に読み直す。** ここは1回の操作の中で完結するので、
  // 手動の改名（`manageChapters.ts`）と同じく、読んですぐ保存する
  const store = new ChapterStore(work);
  let set: ChapterSet;
  try {
    set = await store.load();
  } catch (error) {
    await reportStoreFailure("章立ての読み込み", work, error);
    return false;
  }

  if (!findChapterStartingAt(set.chapters, chapter.startEpisodePath)) {
    vscode.window.showWarningMessage(
      `章「${chapter.name}」は台帳にありません。作品一覧を更新してください。`
    );
    return false;
  }

  const applied = await new ChapterProposalApplier(store, set).apply({
    name: picked.name,
    startEpisodePath: chapter.startEpisodePath,
  });
  if (!applied.ok) {
    vscode.window.showErrorMessage(
      applied.reason ?? "章の名前を保存できませんでした。"
    );
    return false;
  }

  vscode.window.showInformationMessage(
    `章の名前を「${picked.name}」に変えました。`
  );
  return true;
}

/**
 * 提案を提案パネルへ出す。
 *
 * **設定資料の更新と同じ形に載せる**（伏線の候補と同じ理由、設計書6.35.2）。
 * どちらも「1件ずつ承認して保存する」提案であり、描画も適用の道も既にある。
 */
function showChapterProposals(
  panel: ProposalPanel,
  work: WorkEntry,
  material: ChapterMaterial,
  candidates: readonly ChapterProposalCandidate[],
  options: ProposeChaptersOptions
): void {
  const applier = new ChapterProposalApplier(material.store, material.set);
  const byId = new Map<
    string,
    { name: string; startEpisodePath: string }
  >();

  const items: RecordUpdateViewItem[] = candidates.map((candidate) => {
    const episode = material.episodeOf(candidate.startEpisode);
    const startEpisodePath = episodePathFor(
      work.folderPath,
      episode.filePath
    );
    /*
      **名前もidに入れる。** パネルは同じidの提案を1つに畳み、作者が
      既に手を付けたもの（承認・見送り）は新しい結果で置き換えない
      （`core/proposalBuckets.ts` の `mergeProposals`）。開始の話数だけを
      idにすると、**もう一度提案させたときに別の名前の案が黙って消える**
      ——「別の案を見たい」がこの操作の主な使い道なので、そこは分ける。
      同じ案をもう一度出したときは、これまでどおり1つに畳まれる。
    */
    const id = `ch:${candidate.startEpisode}:${candidate.name}`;
    byId.set(id, { name: candidate.name, startEpisodePath });

    return {
      id,
      name: candidate.name,
      changes: describeChapterProposal({
        label: material.labelOf(candidate.startEpisode),
        reason: candidate.reason,
        existingName: findChapterStartingAt(applier.chapters, startEpisodePath)
          ?.name,
      }),
      source: episode.fileName,
      status: "pending" as const,
      applyLabel: "章にする",
    };
  });

  panel.showRecordUpdates(
    work,
    items,
    async (id) => {
      const entry = byId.get(id);
      if (!entry) return { ok: false, reason: "対象が見つかりません。" };
      const result = await applier.apply(entry);
      // 一覧の折りたたみは台帳から作られるので、入ったらすぐ作り直す
      if (result.ok) options.onChaptersChanged?.();
      return result;
    },
    // 見送りは何も書かない。**提案は台帳に無い**ので、片付ける先が無い
    async () => ({ ok: true }),
    CHAPTER_PROPOSAL_CATEGORY
  );
}

/** AIへ渡す材料と、提案を読み解くための手掛かり */
interface ChapterMaterial {
  episodes: ChapterProposeEpisode[];
  current: Array<{ name: string; startEpisode: number | null }>;
  /** 台帳。承認のときに使い回す（読み込み時のハッシュを持っているため） */
  store: ChapterStore;
  set: ChapterSet;
  /** 話数から原稿ファイルへ戻す */
  episodeOf(number: number): EpisodeFile;
  /** 話数から見出し（「第6話」）へ */
  labelOf(number: number): string;
  /** その章に入る話の話数 */
  rangeOf(chapter: Chapter): Set<number>;
}

/**
 * 材料を集める。**本文は読まない**（サブタイトルとあらすじだけ）。
 *
 * **話数の読めない話は渡さない。** 章の開始点として指せないので、
 * 渡すと存在しない番号を作られるだけである（日付で名付けたSNS記事など）。
 */
async function collectMaterial(
  work: WorkEntry
): Promise<ChapterMaterial | undefined> {
  const store = new ChapterStore(work);
  let set: ChapterSet;
  try {
    set = await store.load();
  } catch (error) {
    await reportStoreFailure("章立ての読み込み", work, error);
    return undefined;
  }

  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return undefined;
  }
  const format = await readWorkFormat(work);

  // あらすじが読めなくても提案はできる。材料が減るだけ
  let synopses: Awaited<ReturnType<SynopsisStore["load"]>> | undefined;
  try {
    synopses = await new SynopsisStore(work).load();
  } catch {
    synopses = undefined;
  }

  const files = new Map<number, EpisodeFile>();
  const labels = new Map<number, string>();
  const episodes: ChapterProposeEpisode[] = [];
  for (const episode of scan.episodes) {
    const number = episode.chapterStart;
    if (number === null) continue;
    // 同じ話数のファイルが2つあることがある（合本と単話が並ぶなど）。
    // **先に見つかったほうを使う**——番号は1つの話しか指せない
    if (files.has(number)) continue;

    files.set(number, episode);
    const label = formatChapterLabel(episode, format) || `第${number}話`;
    labels.set(number, label);
    episodes.push({
      number,
      label,
      subtitle: (episode.metaTitle ?? episode.subtitle ?? "").trim(),
      synopsis: synopses
        ? (findSynopsis(synopses, episode.fileName, number)?.synopsis ?? "")
        : "",
    });
  }
  // **話数の順に並べて渡す。** 区切りの判断がこの並びに乗る
  episodes.sort((left, right) => left.number - right.number);

  const grouping = groupEpisodesByChapter(
    scan.episodes,
    set.chapters,
    work.folderPath
  );
  const rangeByStart = new Map<string, Set<number>>();
  for (const group of grouping.groups) {
    rangeByStart.set(
      group.chapter.startEpisodePath,
      new Set(
        group.episodes
          .map((episode) => episode.chapterStart)
          .filter((number): number is number => number !== null)
      )
    );
  }

  return {
    episodes,
    current: set.chapters.map((chapter) => ({
      name: chapter.name,
      // 開始の話が見つからない章もそのまま渡す（黙って消さない）。
      // 話数が分からないことは、プロンプト側が言葉で伝える
      startEpisode: startNumberOf(chapter, rangeByStart),
    })),
    store,
    set,
    episodeOf: (number) => {
      const found = files.get(number);
      // 検証で実在を確かめたあとにしか呼ばない
      if (!found) throw new Error(`第${number}話が見つかりません`);
      return found;
    },
    labelOf: (number) => labels.get(number) ?? `第${number}話`,
    rangeOf: (chapter) =>
      rangeByStart.get(chapter.startEpisodePath) ?? new Set<number>(),
  };
}

/** その章が始まる話数。開始の話が見つからない章では null */
function startNumberOf(
  chapter: Chapter,
  rangeByStart: ReadonlyMap<string, Set<number>>
): number | null {
  const range = rangeByStart.get(chapter.startEpisodePath);
  if (!range || range.size === 0) return null;
  return Math.min(...range);
}

/**
 * 予算に入るプロンプトを組む。
 *
 * **入らないときは、あらすじを落として組み直す。** 章分けはサブタイトルだけでも
 * できるが、話が一覧から抜けると**抜けた話の区切りを提案できなくなる**ので、
 * 話は1つも落とさない。それでも入らなければ諦めて理由を伝える
 * （黙って切り詰めて、後半の見えない提案を出さない）。
 */
function buildPromptWithinBudget(input: {
  workTitle: string;
  episodes: readonly ChapterProposeEpisode[];
  current: ReadonlyArray<{ name: string; startEpisode: number | null }>;
  providerId: string;
  model: string;
  contextWindow: number;
  nameOnly?: { maxSuggestions: number };
}): { text: string; describe: string } | undefined {
  // **材料を空にしてプロンプトを組み、その字数を固定費とする**（設計書6.27.10）
  const overheadChars =
    CHAPTER_PROPOSE_SYSTEM_PROMPT.length +
    buildChapterProposePrompt({
      workTitle: input.workTitle,
      episodes: [],
      current: [],
      nameOnly: input.nameOnly,
    }).length;
  const outputTokens = resolveOutputTokensForPlanning(
    input.providerId,
    input.model
  );
  const chunkSettings = readChunkSettings(
    input.contextWindow,
    { overheadChars, outputTokens },
    { providerId: input.providerId, model: input.model }
  );
  const budget = chunkSettings.chunk.chars;

  const full = buildChapterProposePrompt({
    workTitle: input.workTitle,
    episodes: input.episodes,
    current: input.current,
    nameOnly: input.nameOnly,
  });
  if (full.length - overheadChars <= budget) {
    return {
      text: full,
      describe: `${describeChunkSettings(chunkSettings)}／材料 ${full.length - overheadChars}字（あらすじあり）`,
    };
  }

  const withoutSynopsis = buildChapterProposePrompt({
    workTitle: input.workTitle,
    episodes: input.episodes.map((episode) => ({ ...episode, synopsis: "" })),
    current: input.current,
    nameOnly: input.nameOnly,
  });
  if (withoutSynopsis.length - overheadChars <= budget) {
    return {
      text: withoutSynopsis,
      describe:
        `${describeChunkSettings(chunkSettings)}／材料 ${withoutSynopsis.length - overheadChars}字` +
        "（入りきらないため、あらすじを外した）",
    };
  }
  return undefined;
}

/** AIを1回だけ呼ぶ。中止ボタンをAIまで届かせる（0.28.3と同じ形） */
async function callAI(input: {
  provider: AIProvider;
  model: string;
  prompt: string;
  workFolder: string;
  title: string;
}): Promise<string | undefined> {
  const response = await withCancellableProgress(
    input.title,
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        return await input.provider.generate({
          systemPrompt: CHAPTER_PROPOSE_SYSTEM_PROMPT,
          userPrompt: input.prompt,
          model: input.model,
          // 構成の読み取りなので、抽出寄りに落ち着かせる（名前だけは少し揺らす
          // ほうが案が散るが、同じプロンプトで2つの役をこなすので中間に置く）
          temperature: 0.4,
          maxOutputTokens: resolveOutputTokensForPlanning(
            input.provider.id,
            input.model
          ),
          jsonSchema: CHAPTER_PROPOSE_SCHEMA as unknown as object,
          disableThinking: true,
          signal: controller.signal,
          meta: { feature: "chapter_propose", workFolder: input.workFolder },
        });
      } catch (error) {
        // **関所（`ai/meteredProvider.ts`）で止まった場合もここへ来る。**
        // 再試行の梯子は組まない——1回呼びの機能なので、次の操作を
        // 示して作者に決めてもらうほうが早い
        reportAIError(input.title, error);
        return undefined;
      }
    }
  );
  return response?.text;
}

/** 台帳の失敗は、ログに残してから知らせる（`manageChapters.ts` と同じ形） */
async function reportStoreFailure(
  what: string,
  work: WorkEntry,
  error: unknown
): Promise<void> {
  const message = describeError(error);
  logFailure(what, {
    作品: work.title,
    種類: error instanceof ChapterStoreError ? error.kind : "unknown",
    内容: message,
  });
  await vscode.window.showErrorMessage(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
