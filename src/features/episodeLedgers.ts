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
  relativeMoves,
  renumberBookPositions,
  renumberCharacter,
  renumberChapterSet,
  renumberForeshadow,
  renumberSettingsRecord,
  renumberSynopses,
  renumberTimelineEpisodes,
  type EpisodeRename,
  type EpisodeShift,
} from "../core/episodeRenumber";
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
 *     ページ分割（`BookStore`）、年表の話の指し先（`TimelineStore`）
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
  /** 台帳ごとの失敗。「台帳名：理由」の形。原稿の付け替えは失敗しても戻さない */
  failures: string[];
}

function emptySummary(): LedgerFollowSummary {
  return {
    chapters: 0,
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
    failures: [],
  };
}

/**
 * @param removedFilePath 削除のときだけ渡す。消えた話の絶対パス
 *   （本の設計図の孤児検出に使う。挿入では渡さない）
 */
export async function followEpisodeLedgers(
  work: WorkEntry,
  done: readonly EpisodeRename[],
  shift: EpisodeShift,
  removedFilePath?: string
): Promise<LedgerFollowSummary> {
  const summary = emptySummary();
  const toRelative = (filePath: string) => episodePathFor(work.folderPath, filePath);
  const moves = relativeMoves(done, toRelative);
  const removedRelPath = removedFilePath
    ? normalizeEpisodePath(toRelative(removedFilePath))
    : undefined;
  const renamedFileNames = new Map(
    done.map((rename) => [rename.fromFileName, rename.toFileName])
  );

  await followChapters(work, moves, summary);
  await followBook(work, moves, removedRelPath, summary);
  await followCharacters(work, shift, summary);
  await followSettingsRecords(work, shift, summary);
  await followForeshadows(work, shift, summary);
  await followSynopses(work, shift, renamedFileNames, summary);
  await followTimeline(work, moves, summary);
  await followPendingCharacterUpdates(work, shift, summary);

  return summary;
}

async function followChapters(
  work: WorkEntry,
  moves: ReadonlyMap<string, string>,
  summary: LedgerFollowSummary
): Promise<void> {
  try {
    const store = new ChapterStore(work);
    const set = await store.load();
    const result = renumberChapterSet(set.chapters, moves);
    if (result.changed === 0) return;
    await store.save({ ...set, chapters: result.chapters });
    summary.chapters = result.changed;
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
    const changed = records
      .map((record) => ({ record, result: renumberSettingsRecord(record, shift) }))
      .filter((pair) => pair.result.changed > 0);
    if (changed.length === 0) return;
    await store.saveAll(changed.map((pair) => pair.result.record));
    summary[key] = changed.reduce((sum, pair) => sum + pair.result.changed, 0);
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
    const changed = records
      .map((record) => ({ record, result: renumberForeshadow(record, shift) }))
      .filter((pair) => pair.result.changed > 0);
    if (changed.length === 0) return;
    await store.saveAll(changed.map((pair) => pair.result.record));
    summary.foreshadows = changed.reduce((sum, pair) => sum + pair.result.changed, 0);
  } catch (error) {
    summary.failures.push(`伏線：${messageOf(error, "伏線の話数の追従")}`);
  }
}

async function followSynopses(
  work: WorkEntry,
  shift: EpisodeShift,
  renamedFileNames: ReadonlyMap<string, string>,
  summary: LedgerFollowSummary
): Promise<void> {
  try {
    const store = new SynopsisStore(work);
    const set = await store.load();
    if (set.episodes.length === 0) return;
    const result = renumberSynopses(set.episodes, shift, renamedFileNames);
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

function messageOf(error: unknown, context: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // `kind` を持つのはハッシュ照合系のエラーだけ（各話あらすじ・年表は
  // 退避→新規作成だけで種類を持たない。`core/git.ts` の3つの経路の②③に近い）
  const kind =
    error instanceof ChapterStoreError ||
    error instanceof BookStoreError ||
    error instanceof CharacterStoreError ||
    error instanceof SettingsStoreError
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
  if (summary.synopses > 0) parts.push(`各話あらすじの話数${summary.synopses}件`);
  if (summary.timeline > 0) parts.push(`年表${summary.timeline}件`);
  if (summary.pendingCharacterUpdates > 0)
    parts.push(`保留中の人物更新案${summary.pendingCharacterUpdates}件`);

  const notes: string[] = [];
  if (summary.bookOrphaned > 0)
    notes.push(`消えた話を指す挿絵・ページ位置が${summary.bookOrphaned}件残っています`);
  if (summary.synopsesOrphaned > 0)
    notes.push(`消えた話のあらすじが${summary.synopsesOrphaned}件残っています`);

  if (parts.length === 0 && notes.length === 0) return "";
  const body = parts.length > 0 ? `${parts.join("・")}を付け替えました。` : "";
  const noteText = notes.length > 0 ? notes.join("。") + "。" : "";
  return `${body}${noteText}`.trim();
}
