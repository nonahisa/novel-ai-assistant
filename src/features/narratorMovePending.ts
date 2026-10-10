import type { WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import { CharacterStore } from "../core/characterStore";
import { loadExcerptSources } from "../core/manuscriptSources";
import { applyNarratorMoves, findNarratorMoves } from "../core/narratorMoves";
import {
  NarratorMoveDismissedHistory,
  PendingNarratorMoveStore,
} from "../core/pendingNarratorMoveStore";
import {
  assembleNarratorMoveReview,
  describeNarratorMoveReviewItem,
  destinationFromKeys,
  planNarratorMoveStaging,
  type NarratorMoveReviewItem,
  type PendingNarratorMove,
} from "../core/pendingNarratorMoves";
import { blankMemoLines } from "../core/sceneMemo";
import { isNarratorRecord, workNarratorContextOf } from "../core/sceneNarrators";
import type { RecordUpdateViewItem } from "./proposalPanel";

/**
 * 移す案（語り手の取り違えで主人公に入った値を、別の人物へ移す案）を、
 * 提案パネルの「設定資料の更新」に承認待ちとして出す（作者の裁定 2026-10-10
 * 「提案パネルにも出す」。設計書6.5.12）。
 *
 * - 積む：設定資料の抽出の終わり（`stageNarratorMovesAfterExtraction`）
 * - 並べる：`reviewPendingNarratorMoves` → `narratorMoveViewItems`
 * - 反映：`applyPendingNarratorMove`（移し先 → 主人公の順に `saveOrUpdate`）
 * - 見送る：`dismissPendingNarratorMove`（鍵を覚えてから承認待ちを消す）
 *
 * 見つけ方・反映の中身は設定資料パネルの「AIで再読込」と同じ関数
 * （`findNarratorMoves`・`applyNarratorMoves`）を通す。写しを作らない。
 */

/**
 * 抽出の終わりに、主人公の資料に疑う値があれば移す案を積む。
 *
 * **見るのは保存済みの主人公**（台帳）。今回の抽出で初めて入る値は、まだ
 * 人物の承認待ち（更新案）の中にしか無く、積んでも反映のときに「見つからない」
 * になる——その値は更新案を承認したあとの次の抽出で積まれる。
 *
 * 語り手が決まらない作品・人物設定が読めないときは何もしない（0件）。
 *
 * @returns 新しく積んだ件数
 */
export async function stageNarratorMovesAfterExtraction(
  work: WorkEntry,
  now: string = new Date().toISOString()
): Promise<number> {
  const loaded = await new CharacterStore(work).loadAll();
  // 読めない人物があると語り手も移し先も決めきれない。積まない
  if (loaded.errors.length > 0) return 0;
  const { sources } = await loadExcerptSources(work);
  if (sources.length === 0) return 0;
  // 語り手の決め方は「AIで再読込」と同じ（全話を繋いだ本文。`settingsPanel.narrationOf`）
  const context = workNarratorContextOf(
    sources.map((source) => blankMemoLines(source.text)).join("\n"),
    loaded.characters
  );
  if (!context) return 0;

  const found = loaded.characters
    .filter((person) => isNarratorRecord([person.name, ...person.aliases], context))
    .map((person) => ({ source: person, items: findNarratorMoves(person, context, sources) }))
    .filter((entry) => entry.items.length > 0);
  if (found.length === 0) return 0;

  const store = new PendingNarratorMoveStore(work);
  const pending = await store.loadAll();
  const dismissed = await new NarratorMoveDismissedHistory(work).load();
  const staged = planNarratorMoveStaging(found, {
    // 読めなかった承認待ちの鍵は分からない。同じ名前のファイルへ積むと、
    // 壊れたファイルを置き換えてしまうので、その主人公の案は積まない
    pendingKeys: new Set(pending.moves.map((move) => move.key)),
    dismissedKeys: dismissed,
    now,
  }).filter(
    (payload) =>
      !pending.errors.some((error) => error.file.startsWith(`${payload.sourceId}_`))
  );
  await store.stage(staged);
  return staged.length;
}

export interface PendingNarratorMoveReview {
  items: NarratorMoveReviewItem[];
  /** 片付けてよい案（主人公が居ない・値がもう無い） */
  stale: PendingNarratorMove[];
  totalPending: number;
  pendingErrors: Array<{ file: string; message: string }>;
  /** 読めなかった人物設定。1件でもあれば組み立てない（片付けもしない） */
  characterErrors: Array<{ file: string; message: string }>;
  store: PendingNarratorMoveStore;
}

/** 承認待ちを読み、並べられる形に組む。**ここでは何も書かない** */
export async function reviewPendingNarratorMoves(
  work: WorkEntry
): Promise<PendingNarratorMoveReview> {
  const store = new PendingNarratorMoveStore(work);
  const pending = await store.loadAll();
  const review: PendingNarratorMoveReview = {
    items: [],
    stale: [],
    totalPending: pending.moves.length,
    pendingErrors: pending.errors,
    characterErrors: [],
    store,
  };
  if (pending.moves.length === 0) return review;
  const loaded = await new CharacterStore(work).loadAll();
  review.characterErrors = loaded.errors;
  if (loaded.errors.length > 0) return review;
  const assembled = assembleNarratorMoveReview(pending.moves, loaded.characters);
  review.items = assembled.items;
  review.stale = assembled.stale.map((entry) => entry.move);
  return review;
}

/** 提案パネルの行（人物の更新案と同じ「設定資料の更新」に並ぶ） */
export function narratorMoveViewItems(
  review: PendingNarratorMoveReview
): RecordUpdateViewItem[] {
  return review.items.map((item) => {
    const text = describeNarratorMoveReviewItem(item);
    return {
      id: item.move.filePath,
      name: item.source.name,
      changes: text.changes,
      source: text.source,
      status: "pending" as const,
      moveChoice: {
        options: item.options,
        selected: item.defaultId,
      },
    };
  });
}

/** 反映の結果（ログと知らせに使う） */
export interface NarratorMoveApplied {
  sourceName: string;
  /** 移し先の名前。null は外すだけ */
  destinationName: string | null;
  /** 移し先の値を上書きしなかったことの説明 */
  notes: string[];
}

/**
 * 移す案を1件反映する（**作者が承認したときだけ呼ぶ**）。
 *
 * - いまの台帳を読み直してから組む（パネルを開いてから別の行を反映していても、
 *   その結果の上に重ねる。開いたときの写しで書くと、先に外した値が戻る）
 * - **移し先 → 主人公の順に書く**。移し先で失敗したら主人公は書かない
 *   （値は主人公に残る）。移し先が書けて主人公で失敗したら、値は両方に残る
 *   ——**どちらの失敗でも値は消えない**。承認待ちは残すので、押し直せる
 *   （移し先へ足す処理は同じ値を二重に足さない）
 * - 人物は `saveOrUpdate`（退避 → 新規作成）。直に `save` を呼ばない
 */
export async function applyPendingNarratorMove(
  work: WorkEntry,
  item: NarratorMoveReviewItem,
  dropKeys: readonly string[] | undefined,
  store: PendingNarratorMoveStore,
  now: string = new Date().toISOString()
): Promise<NarratorMoveApplied> {
  // 移し先を選ばないまま反映しない（例外の文は画面の行にそのまま出る）
  const destinationId = destinationFromKeys(dropKeys, item);
  const characterStore = new CharacterStore(work);
  const loaded = await characterStore.loadAll();
  if (loaded.errors.length > 0) {
    throw new Error(
      `読み込めない人物設定があるため、移しませんでした（${loaded.errors
        .map((error) => error.file)
        .join("、")}）。`
    );
  }
  const source = loaded.characters.find((person) => person.id === item.move.sourceId);
  if (!source) {
    throw new Error(`「${item.move.sourceName}」が資料に見つかりません。見送ってください。`);
  }
  const outcome = applyNarratorMoves(
    source,
    loaded.characters,
    [{ item: item.move.item, destinationId }],
    now
  );
  if (outcome.missing > 0) {
    throw new Error(
      `「${source.name}」の資料に、この値がもうありません（直したか、別の承認で外れています）。見送ってください。`
    );
  }
  const destination: Character | undefined = outcome.destinations[0];
  for (const record of outcome.destinations) {
    await characterStore.saveOrUpdate(record);
  }
  try {
    await characterStore.saveOrUpdate(outcome.source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      destination
        ? `「${destination.name}」には入りましたが、「${source.name}」からは外せませんでした` +
            `（値は両方に残っていて、消えてはいません。もう一度押すと外します）。${message}`
        : message
    );
  }
  await store.discard(item.move.filePath);
  return {
    sourceName: source.name,
    destinationName: destination ? destination.name : null,
    notes: outcome.notes,
  };
}

/**
 * 移す案を見送る。**鍵を覚えてから**承認待ちを消す——覚えられないまま消すと、
 * 次の抽出で同じ案がまた積まれる（覚えられなければ例外。承認待ちは残る）。
 * 資料には触らない。
 */
export async function dismissPendingNarratorMove(
  work: WorkEntry,
  item: NarratorMoveReviewItem,
  store: PendingNarratorMoveStore
): Promise<void> {
  await new NarratorMoveDismissedHistory(work).add([item.move.key]);
  await store.discard(item.move.filePath);
}
