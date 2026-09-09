import type { WorkEntry } from "../models/types";
import { ChapterStore, ChapterStoreError } from "../core/chapterStore";
import { BookStore, BookStoreError, episodePathFor } from "../core/bookStore";
import { CharacterStore, CharacterStoreError } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { SettingsStore, SettingsStoreError, type StorableRecord } from "../core/settingsStore";
import { createForeshadowStore } from "../core/foreshadowStore";
import { SynopsisStore } from "../core/synopsisStore";
import { TimelineStore } from "../core/timelineStore";
import { PendingUpdateStore } from "../core/pendingUpdates";
import type { RecordConflict } from "../models/jsonValidation";
import {
  episodeNumberMoves,
  relativeMoves,
  renamedFileNamesByNumber,
  renumberBookPositions,
  renumberCharacter,
  renumberChapterSet,
  renumberForeshadow,
  renumberPostingPosts,
  renumberSettingsRecord,
  renumberSynopses,
  renumberTimelineEpisodes,
  type EpisodeRename,
  type EpisodeShift,
} from "../core/episodeRenumber";
import { PostingStore, PostingStoreError } from "../core/postingStore";
import { normalizeEpisodePath } from "../models/chapter";
import { logFailure } from "../core/logger";

/**
 * 話数を指している台帳を、付け替えと同じ操作の中で追従させる（設計書6.67.3）。
 *
 * **原稿の付け替え（呼び出し側で既に済んでいる）は巻き戻さない。** ここで
 * 1つの台帳が失敗しても、原因をこの台帳ぶんだけ `failures` に積んで
 * 次の台帳へ進む——1つの台帳の不調で、ほかの台帳への追従まで諦める
 * 理由が無い。
 *
 * 洗い出した台帳（実装時に全台帳を検索して確かめた）：
 *   - パスで指すもの：章立て（`ChapterStore`）、本の設計図の挿絵・
 *     ページ分割（`BookStore`）、年表の話の指し先（`TimelineStore`）、
 *     投稿状態（`PostingStore`。設計書6.68.2）
 *   - 話数の数字で指すもの：登場人物（`CharacterStore`）、能力・場所・
 *     組織・世界観（`SettingsStore` 系）、伏線（`foreshadowStore`）、
 *     各話あらすじ（`SynopsisStore`）、保留中の人物更新案
 *     （`PendingUpdateStore`。作者の承認前の下書きだが、承認後に古い話数の
 *     まま反映されると人物の記録が狂うため対象に含めた）
 *
 * **追従しないと判断したもの**（設計書6.67.3の「追従しないもの」に加えて
 * 確かめたもの）：
 *   - 提案（`proposalStore.ts`）・編集履歴（`editHistory.ts`）・校閲ロック
 *     （`fileLockStore.ts`）：**追記専用で複数環境から同期される特殊な台帳**。
 *     話数の付け替えのついでに書き換えると、同期の「追記だけ」という
 *     前提を崩し、他環境からの取り込みと衝突しうる。触るなら別途の設計判断が要る
 *   - シーンメモ（`sceneMemo.ts`）：台帳を持たず、原稿の中に書き込まれた
 *     コメント行を都度読み取るだけ。ファイル名の付け替えに自動でついてくる
 *   - 追加項目の定義（`customFieldStore.ts`）：項目の名前や型を持つだけで、
 *     話数を持つ値そのものは各レコードの `customFields` に入り、
 *     構造化されていないため機械的に追従できない
 */
export interface LedgerFollowSummary {
  chapters: number;
  /** 開始の話が消えたので、次の話へ移した章（「第二章」→「第3話」） */
  chapterStartMoves: Array<{ name: string; toLabel: string }>;
  /** 中身が空になったので外した章の名前 */
  chapterDrops: string[];
  bookPositions: number;
  bookOrphaned: number;
  characters: number;
  abilities: number;
  locations: number;
  organizations: number;
  world: number;
  foreshadows: number;
  synopses: number;
  synopsesOrphaned: number;
  timeline: number;
  pendingCharacterUpdates: number;
  /** 指し先を付け替えた投稿の記録（設計書6.68.2） */
  posting: number;
  /** 消えた話を指していたので外した投稿の記録。**黙って外さない**ために数える */
  postingDropped: number;
  /** 台帳ごとの失敗。「台帳名：理由」の形。原稿の付け替えは失敗しても戻さない */
  failures: string[];
}

export function emptyLedgerFollowSummary(): LedgerFollowSummary {
  return {
    chapters: 0,
    chapterStartMoves: [],
    chapterDrops: [],
    bookPositions: 0,
    bookOrphaned: 0,
    characters: 0,
    abilities: 0,
    locations: 0,
    organizations: 0,
    world: 0,
    foreshadows: 0,
    synopses: 0,
    synopsesOrphaned: 0,
    timeline: 0,
    pendingCharacterUpdates: 0,
    posting: 0,
    postingDropped: 0,
    failures: [],
  };
}

/** 削除された話。削除の追従にだけ渡す（挿入では渡さない） */
export interface RemovedEpisode {
  /** 消えた話の絶対パス（本の設計図の孤児検出・章立ての付け替えに使う） */
  filePath: string;
  /** 消えた話の話数。台帳からはこの番号だけを落とす */
  number: number;
  /**
   * 消えた話の**次の話**（付け替えが済んだあとの姿）。後ろに話が無ければ
   * undefined。開始の話を消された章を、どこへ移すかに使う（6.67.3）。
   */
  next?: { filePath: string; number: number | null };
}

/**
 * 台帳を、**実際に動いた話の対応表**で追従させる。
 *
 * `done` は済んだ付け替えだけなので、途中で止まった付け替えや、動かせ
 * なかった話（合本・名前の読めない話）は対応表に入らない——入らない話数は
 * 台帳でも動かさない。**算術（pivot 以降を ±1）に戻さないこと。**
 */
export async function followEpisodeLedgers(
  work: WorkEntry,
  done: readonly EpisodeRename[],
  removed?: RemovedEpisode
): Promise<LedgerFollowSummary> {
  const summary = emptyLedgerFollowSummary();
  const toRelative = (filePath: string) => episodePathFor(work.folderPath, filePath);
  const moves = relativeMoves(done, toRelative);
  const shift: EpisodeShift = {
    moved: episodeNumberMoves(done),
    removed: removed?.number,
  };
  const removedPaths = removed
    ? {
        path: normalizeEpisodePath(toRelative(removed.filePath)),
        nextPath: removed.next
          ? normalizeEpisodePath(toRelative(removed.next.filePath))
          : undefined,
      }
    : undefined;

  await followChapters(work, moves, removedPaths, removed?.next?.number, summary);
  await followBook(work, moves, removedPaths?.path, summary);
  await followCharacters(work, shift, summary);
  await followSettingsRecords(work, shift, summary);
  await followForeshadows(work, shift, summary);
  await followSynopses(work, shift, renamedFileNamesByNumber(done), summary);
  await followTimeline(work, moves, summary);
  await followPendingCharacterUpdates(work, shift, summary);
  await followPosting(work, moves, removedPaths?.path, summary);

  return summary;
}

async function followChapters(
  work: WorkEntry,
  moves: ReadonlyMap<string, string>,
  removed: { path: string; nextPath?: string } | undefined,
  /** 次の話の、付け替え後の話数（通知の「第◯話へ移しました」に使う） */
  nextNumber: number | null | undefined,
  summary: LedgerFollowSummary
): Promise<void> {
  try {
    const store = new ChapterStore(work);
    const set = await store.load();
    const result = renumberChapterSet(set.chapters, moves, removed);
    if (result.changed === 0) return;
    await store.save({ ...set, chapters: result.chapters });
    summary.chapters = result.changed;
    // **移した先・外したことは、必ず作者へ見せる**（黙って章を動かさない）
    summary.chapterStartMoves = result.movedStarts.map((moved) => ({
      name: moved.name,
      toLabel:
        nextNumber !== null && nextNumber !== undefined
          ? `第${nextNumber}話`
          : `「${moved.toPath}」`,
    }));
    summary.chapterDrops = result.dropped;
  } catch (error) {
    summary.failures.push(`章立て：${messageOf(error, "章立ての追従")}`);
  }
}

async function followBook(
  work: WorkEntry,
  moves: ReadonlyMap<string, string>,
  removedRelPath: string | undefined,
  summary: LedgerFollowSummary
): Promise<void> {
  try {
    const store = new BookStore(work);
    const config = await store.load();
    const result = renumberBookPositions(
      { illustrations: config.illustrations, pageBreaks: config.pageBreaks },
      moves,
      removedRelPath
    );
    if (result.changed === 0 && result.orphaned === 0) return;
    if (result.changed > 0) {
      await store.save({
        ...config,
        illustrations: result.illustrations,
        pageBreaks: result.pageBreaks,
      });
      summary.bookPositions = result.changed;
    }
    summary.bookOrphaned = result.orphaned;
  } catch (error) {
    summary.failures.push(`本の設計図：${messageOf(error, "本の設計図の追従")}`);
  }
}

async function followCharacters(
  work: WorkEntry,
  shift: EpisodeShift,
  summary: LedgerFollowSummary
): Promise<void> {
  try {
    const store = new CharacterStore(work);
    const { characters } = await store.loadAll();
    let changed = 0;
    for (const character of characters) {
      const result = renumberCharacter(character, shift);
      if (result.changed === 0) continue;
      try {
        // **`save()` を直接呼ばない。** 既存人物は退避→新規作成で書き換える
        // 決まり（CLAUDE.md 規則2）を `saveOrUpdate` が引き受ける
        await store.saveOrUpdate(result.character);
        changed += result.changed;
      } catch (error) {
        summary.failures.push(
          `人物「${character.name}」：${messageOf(error, "人物の話数の追従")}`
        );
      }
    }
    summary.characters = changed;
  } catch (error) {
    summary.failures.push(`人物設定：${messageOf(error, "人物一覧の読み込み")}`);
  }
}

/** 話数を持つ4つの設定資料（能力・場所・組織・世界観）。同じ形で持つので1つの関数で足りる */
async function followSettingsRecords(
  work: WorkEntry,
  shift: EpisodeShift,
  summary: LedgerFollowSummary
): Promise<void> {
  await followSettingsStore(
    "能力",
    createAbilityStore(work),
    shift,
    summary,
    "abilities"
  );
  await followSettingsStore(
    "場所",
    createLocationStore(work),
    shift,
    summary,
    "locations"
  );
  await followSettingsStore(
    "組織",
    createOrganizationStore(work),
    shift,
    summary,
    "organizations"
  );
  await followSettingsStore("世界観", createWorldStore(work), shift, summary, "world");
}

interface ChapteredStorable extends StorableRecord {
  /** 失敗を伝えるときの呼び名。IDだけでは作者にどれか分からない */
  name: string;
  appearedChapters: number[];
  conflicts: RecordConflict[];
}

async function followSettingsStore<T extends ChapteredStorable>(
  label: string,
  store: SettingsStore<T>,
  shift: EpisodeShift,
  summary: LedgerFollowSummary,
  key: "abilities" | "locations" | "organizations" | "world"
): Promise<void> {
  try {
    const { records } = await store.loadAll();
    summary[key] = await saveEachRecord(
      records.map((record) => ({
        display: `${label}「${record.name}」`,
        result: renumberSettingsRecord(record, shift),
      })),
      (record) => store.saveAll([record]),
      `${label}の話数の追従`,
      summary
    );
  } catch (error) {
    summary.failures.push(`${label}：${messageOf(error, `${label}の話数の追従`)}`);
  }
}

async function followForeshadows(
  work: WorkEntry,
  shift: EpisodeShift,
  summary: LedgerFollowSummary
): Promise<void> {
  try {
    const store = createForeshadowStore(work);
    const { records } = await store.loadAll();
    summary.foreshadows = await saveEachRecord(
      records.map((record) => ({
        display: `伏線「${record.label}」`,
        result: renumberForeshadow(record, shift),
      })),
      (record) => store.saveAll([record]),
      "伏線の話数の追従",
      summary
    );
  } catch (error) {
    summary.failures.push(`伏線：${messageOf(error, "伏線の話数の追従")}`);
  }
}

/**
 * 1件ずつ保存して、**書けたものだけを数える**（設計書6.67.3）。
 *
 * まとめて保存したうえで件数を後から代入すると、途中で失敗したときに
 * 「0件」になる。実際には何件か書けているので、**作者が次に何を確かめれば
 * よいのか分からなくなる**（人物の追従は元から1件ずつで、そちらに合わせた）。
 */
async function saveEachRecord<T>(
  entries: ReadonlyArray<{
    display: string;
    result: { record: T; changed: number };
  }>,
  save: (record: T) => Promise<void>,
  context: string,
  summary: LedgerFollowSummary
): Promise<number> {
  let changed = 0;
  for (const entry of entries) {
    if (entry.result.changed === 0) continue;
    try {
      await save(entry.result.record);
      changed += entry.result.changed;
    } catch (error) {
      summary.failures.push(`${entry.display}：${messageOf(error, context)}`);
    }
  }
  return changed;
}

async function followSynopses(
  work: WorkEntry,
  shift: EpisodeShift,
  /** 旧話数 → 旧・新のファイル名。**名前でなく話数から引く**（取り違え防止） */
  renamedFileNames: ReadonlyMap<
    number,
    { fromFileName: string; toFileName: string }
  >,
  summary: LedgerFollowSummary
): Promise<void> {
  try {
    const store = new SynopsisStore(work);
    const set = await store.load();
    if (set.episodes.length === 0) return;
    const result = renumberSynopses(set.episodes, shift, renamedFileNames);
    // **`changed` にはファイル名だけが変わった行も入る**（数えないと、
    // 名前を書き換えたまま保存されずに捨てられる）
    if (result.changed === 0 && result.orphaned === 0) return;
    if (result.changed > 0) {
      await store.save({ ...set, episodes: result.episodes });
    }
    summary.synopses = result.changed;
    summary.synopsesOrphaned = result.orphaned;
  } catch (error) {
    summary.failures.push(`各話あらすじ：${messageOf(error, "各話あらすじの追従")}`);
  }
}

async function followTimeline(
  work: WorkEntry,
  moves: ReadonlyMap<string, string>,
  summary: LedgerFollowSummary
): Promise<void> {
  if (moves.size === 0) return;
  try {
    const store = new TimelineStore(work);
    const timeline = await store.load();
    if (timeline.episodes.length === 0) return;
    const result = renumberTimelineEpisodes(timeline.episodes, moves);
    if (result.changed === 0) return;
    await store.save({ ...timeline, episodes: result.episodes });
    summary.timeline = result.changed;
  } catch (error) {
    summary.failures.push(`年表：${messageOf(error, "年表の追従")}`);
  }
}

async function followPendingCharacterUpdates(
  work: WorkEntry,
  shift: EpisodeShift,
  summary: LedgerFollowSummary
): Promise<void> {
  try {
    const store = new PendingUpdateStore(work);
    const { updates } = await store.loadAll();
    const changed = updates
      .map((update) => ({ update, result: renumberCharacter(update.character, shift) }))
      .filter((pair) => pair.result.changed > 0);
    if (changed.length === 0) return;
    // 保留ファイルは作者の原稿ではない（承認前の下書き）ので上書きしてよい。
    // `PendingUpdateStore.stage` がその前提で書く（ハッシュ照合は行わない）
    await store.stage(changed.map((pair) => pair.result.character));
    summary.pendingCharacterUpdates = changed.reduce(
      (sum, pair) => sum + pair.result.changed,
      0
    );
  } catch (error) {
    summary.failures.push(
      `保留中の人物更新案：${messageOf(error, "保留中の更新案の追従")}`
    );
  }
}

/**
 * 投稿状態の記録を付け替える（設計書6.68.2）。
 *
 * **投稿サイトへは何もしない。** 書き換えるのは手元の台帳だけである。
 */
async function followPosting(
  work: WorkEntry,
  moves: ReadonlyMap<string, string>,
  removedRelPath: string | undefined,
  summary: LedgerFollowSummary
): Promise<void> {
  try {
    const store = new PostingStore(work);
    const ledger = await store.load();
    if (ledger.posts.length === 0) return;
    const result = renumberPostingPosts(ledger.posts, moves, removedRelPath);
    if (result.changed === 0 && result.dropped === 0) return;
    await store.save({ ...ledger, posts: result.posts });
    summary.posting = result.changed;
    summary.postingDropped = result.dropped;
  } catch (error) {
    summary.failures.push(`投稿状態：${messageOf(error, "投稿状態の追従")}`);
  }
}

function messageOf(error: unknown, context: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // `kind` を持つのはハッシュ照合系のエラーだけ（各話あらすじ・年表は
  // 退避→新規作成だけで種類を持たない。`core/git.ts` の3つの経路の②③に近い）
  const kind =
    error instanceof ChapterStoreError ||
    error instanceof BookStoreError ||
    error instanceof CharacterStoreError ||
    error instanceof SettingsStoreError ||
    error instanceof PostingStoreError
      ? error.kind
      : "unknown";
  logFailure(context, {
    種類: kind,
    内容: message,
  });
  return message;
}

/**
 * 追従の結果を作者の言葉にする（「章立て1件・挿絵2件・登場人物の話数14件を
 * 付け替えました」の形、設計書6.67.3）。**黙って書き換えない**ための表示。
 */
export function describeLedgerFollowSummary(summary: LedgerFollowSummary): string {
  const parts: string[] = [];
  if (summary.chapters > 0) parts.push(`章立て${summary.chapters}件`);
  if (summary.bookPositions > 0) parts.push(`挿絵・ページ位置${summary.bookPositions}件`);
  if (summary.characters > 0) parts.push(`登場人物の話数${summary.characters}件`);
  if (summary.abilities > 0) parts.push(`能力の話数${summary.abilities}件`);
  if (summary.locations > 0) parts.push(`場所の話数${summary.locations}件`);
  if (summary.organizations > 0) parts.push(`組織の話数${summary.organizations}件`);
  if (summary.world > 0) parts.push(`世界観の話数${summary.world}件`);
  if (summary.foreshadows > 0) parts.push(`伏線の話数${summary.foreshadows}件`);
  if (summary.synopses > 0) parts.push(`各話あらすじ${summary.synopses}件`);
  if (summary.timeline > 0) parts.push(`年表${summary.timeline}件`);
  if (summary.pendingCharacterUpdates > 0)
    parts.push(`保留中の人物更新案${summary.pendingCharacterUpdates}件`);
  if (summary.posting > 0) parts.push(`投稿状態${summary.posting}件`);

  const notes: string[] = [];
  // **章の開始が動いたことは、件数ではなく章の名前で伝える**（作者は
  // 「章立て1件」では、どの章がどこへ移ったのか分からない）
  for (const moved of summary.chapterStartMoves) {
    notes.push(`章「${moved.name}」の開始を${moved.toLabel}へ移しました`);
  }
  for (const name of summary.chapterDrops) {
    notes.push(`章「${name}」は中身が空になったため外しました`);
  }
  if (summary.bookOrphaned > 0)
    notes.push(`消えた話を指す挿絵・ページ位置が${summary.bookOrphaned}件残っています`);
  if (summary.synopsesOrphaned > 0)
    notes.push(`消えた話のあらすじが${summary.synopsesOrphaned}件残っています`);
  // **外したことは必ず言う。** 残すと別の話が投稿済みに見えるので落としたが、
  // 黙って落とすと「出したはずの記録が消えた」と読まれる
  if (summary.postingDropped > 0)
    notes.push(`消えた話の投稿の記録を${summary.postingDropped}件外しました`);

  if (parts.length === 0 && notes.length === 0) return "";
  const body = parts.length > 0 ? `${parts.join("・")}を付け替えました。` : "";
  const noteText = notes.length > 0 ? notes.join("。") + "。" : "";
  return `${body}${noteText}`.trim();
}
