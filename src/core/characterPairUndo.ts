import type { Character } from "../models/character";
import type { PendingUpdate } from "./pendingReview";
import {
  pendingOfPair,
  restagePendingUpdate,
  type DistinctUndoTicket,
  type PendingCharacterWriter,
  type UnifyUndoTicket,
} from "./characterPairDecision";

/**
 * 重複の候補の［戻す］（設計書6.5.4「押した直後の帯の［戻す］」。作者の裁定 2026-10-20・10-22）。
 *
 * 設定資料パネルの帯が持つのは**直近の1手だけ**で、ここはその1手を戻す。作りは
 * 校正・メモパネルの［済み］の［戻す］（6.40.4）に揃える——戻す前に、いまの記録が
 * その手の直後のままかを確かめ、**変わっていたら当て推量で戻さず、理由を返して何も書かない。**
 *
 * - **まとめた手**：まとめた人物を退避し、回復用の場所（`.novelai-recovery`）に残した
 *   元の2つのファイルを元の保存先へ戻す（`CharacterStore.restoreRetired`。新規作成でしか書かない）
 * - **別人にした手**：書く前の2人を `saveOrUpdate` で書き直す。照合で「書いた直後のまま」と
 *   分かっているので、互いを指す別人の記録が消え、外した別名が戻る
 * - どちらも、片づけた・寄せた反映待ちを元の姿で積み直す。寄せた反映待ちを残したまま戻すと、
 *   それを［確かめて反映］したときに、戻したはずのまとめがまた入る
 *
 * `vscode` に触らない（ストアは必要な口だけ受け取る）。
 */

/** 戻すのに使う口（`CharacterStore` の一部） */
export interface UndoCharacterStore {
  loadAll(): Promise<{
    characters: Character[];
    errors: Array<{ file: string; message: string }>;
  }>;
  snapshotOf(id: string): { filePath: string; hash: string } | undefined;
  fileHash(filePath: string): Promise<string | undefined>;
  retire(id: string): Promise<string>;
  restoreRetired(
    recoveryPath: string,
    destinationPath: string,
    expectedHash: string
  ): Promise<void>;
  saveOrUpdate(character: Character): Promise<void>;
}

export type PairUndoTicket = UnifyUndoTicket | DistinctUndoTicket;

/**
 * 戻した結果。
 *
 * - `done`：戻した。帯をこの文に替え、札は捨てる
 * - `refused`：記録が変わっていたので戻さなかった。**何も書いていない。** 帯をこの文に替え、札は捨てる
 * - `blocked`：書く前に断られた（未保存の変更・読み込めないファイルなど）。何も書いていない。
 *   直せばもう一度押せるので、**帯と札は残す**（6.40.4 の「書き込みが断られたときは帯を残す」）
 * - `broken`：途中まで書いて止まった。窓で止めて、手で戻す先を出す。札は捨てる
 */
export type PairUndoOutcome =
  | { kind: "done"; band: string }
  | { kind: "refused"; band: string }
  | { kind: "blocked"; message: string }
  | { kind: "broken"; message: string };

export async function undoPairDecision(
  store: UndoCharacterStore,
  pending: PendingCharacterWriter,
  ticket: PairUndoTicket
): Promise<PairUndoOutcome> {
  return ticket.kind === "unify"
    ? undoUnify(store, pending, ticket)
    : undoDistinct(store, pending, ticket);
}

const REFUSED_TAIL = "何も書き換えていません。";

function refused(reason: string): PairUndoOutcome {
  return { kind: "refused", band: `戻せませんでした。${reason}${REFUSED_TAIL}` };
}

/** 書く前の共通の確かめ（読み込めない人物・反映待ちが読めるか）。断るなら結果を返す */
async function loadForUndo(
  store: UndoCharacterStore,
  pending: PendingCharacterWriter
): Promise<
  | { ok: true; characters: Character[]; pendingUpdates: PendingUpdate[] }
  | { ok: false; outcome: PairUndoOutcome }
> {
  const loaded = await store.loadAll();
  if (loaded.errors.length > 0) {
    // 壊れたJSONは直さず止める（規則2）。直せばもう一度押せる
    return {
      ok: false,
      outcome: {
        kind: "blocked",
        message:
          "読み込めない人物のファイルがあるため、戻すのを見合わせました。" +
          `（${loaded.errors.map((error) => error.file).join("、")}）`,
      },
    };
  }
  let pendingUpdates: PendingUpdate[];
  try {
    pendingUpdates = (await pending.loadAll()).updates;
  } catch (error) {
    return {
      ok: false,
      outcome: {
        kind: "blocked",
        message: `反映待ちの更新を読めないため、戻すのを見合わせました。${messageOf(error)}`,
      },
    };
  }
  return { ok: true, characters: loaded.characters, pendingUpdates };
}

async function undoUnify(
  store: UndoCharacterStore,
  pending: PendingCharacterWriter,
  ticket: UnifyUndoTicket
): Promise<PairUndoOutcome> {
  const { keep, absorb } = ticket;
  const loaded = await loadForUndo(store, pending);
  if (!loaded.ok) return loaded.outcome;

  // ── 確かめる（ここまで何も書かない） ──
  const unified = store.snapshotOf(keep.id);
  if (!unified || unified.hash !== ticket.unifiedHash) {
    return refused(`「${keep.name}」が、まとめたあとに書き換えられています。`);
  }
  if (
    store.snapshotOf(absorb.id) ||
    loaded.characters.some((character) => character.id === absorb.id)
  ) {
    return refused(`「${absorb.name}」の記録が、まとめたあとにまたできています。`);
  }
  for (const file of [keep, absorb]) {
    if ((await store.fileHash(file.recoveryPath)) !== file.hash) {
      return refused(
        `回復用の場所にある「${file.name}」の元のファイルが、見つからないか変わっています。`
      );
    }
  }
  if ((await store.fileHash(absorb.filePath)) !== undefined) {
    return refused(`「${absorb.name}」の元の保存先に、別のファイルがあります。`);
  }
  if (
    keep.filePath !== unified.filePath &&
    (await store.fileHash(keep.filePath)) !== undefined
  ) {
    return refused(`「${keep.name}」の元の保存先に、別のファイルがあります。`);
  }
  if (
    !samePendingUpdates(
      pendingOfPair(loaded.pendingUpdates, keep.id, absorb.id),
      ticket.pendingAfter
    )
  ) {
    return refused("その後の抽出などで、2人の反映待ちの更新が変わっています。");
  }

  // ── 戻す ──
  let unifiedRecoveryPath: string;
  try {
    unifiedRecoveryPath = await store.retire(keep.id);
  } catch (error) {
    // 退避は照合してから移すので、失敗したときは何も動いていない
    return { kind: "blocked", message: `戻せませんでした。${messageOf(error)}` };
  }
  try {
    await store.restoreRetired(keep.recoveryPath, keep.filePath, keep.hash);
  } catch (error) {
    return {
      kind: "broken",
      message:
        `まとめた「${keep.name}」は回復用の場所へ移しましたが、元の「${keep.name}」を戻せませんでした。` +
        `${messageOf(error)}\n次の場所のファイルを確かめて、手動で戻してください:\n` +
        `まとめた内容: ${unifiedRecoveryPath}\n` +
        `元の「${keep.name}」: ${keep.recoveryPath}\n` +
        `元の「${absorb.name}」: ${absorb.recoveryPath}`,
    };
  }
  try {
    await store.restoreRetired(absorb.recoveryPath, absorb.filePath, absorb.hash);
  } catch (error) {
    return {
      kind: "broken",
      message:
        `「${keep.name}」は元に戻しましたが、「${absorb.name}」を戻せませんでした。` +
        `${messageOf(error)}\n元のファイルは次の場所にあります。手動で戻してください:\n` +
        absorb.recoveryPath,
    };
  }

  const pendingNote = await restorePending(
    pending,
    ticket.pendingAfter,
    ticket.pendingBefore,
    keep.name,
    absorb.name
  );
  return {
    kind: "done",
    band:
      `まとめる前に戻しました。「${keep.name}」と「${absorb.name}」は別々の記録に戻り、` +
      "まとめた内容は回復用の場所（設定/characters/.novelai-recovery）に残っています。" +
      pendingNote,
  };
}

async function undoDistinct(
  store: UndoCharacterStore,
  pending: PendingCharacterWriter,
  ticket: DistinctUndoTicket
): Promise<PairUndoOutcome> {
  const [first, second] = ticket.pair;
  const loaded = await loadForUndo(store, pending);
  if (!loaded.ok) return loaded.outcome;

  for (const entry of ticket.pair) {
    if (store.snapshotOf(entry.before.id)?.hash !== entry.afterHash) {
      return refused(`「${entry.before.name}」が、別人として覚えたあとに書き換えられています。`);
    }
  }
  if (pendingOfPair(loaded.pendingUpdates, first.before.id, second.before.id).length > 0) {
    // 別人にしたときに2人の反映待ちは片づけた。あるのは、そのあとに積まれた分
    return refused("その後の抽出などで、2人の反映待ちの更新が積まれています。");
  }

  try {
    await store.saveOrUpdate(first.before);
  } catch (error) {
    if (!isAmbiguous(error)) {
      return { kind: "blocked", message: `戻せませんでした。${messageOf(error)}` };
    }
    return { kind: "broken", message: `「${first.before.name}」を戻せませんでした。${messageOf(error)}` };
  }
  try {
    await store.saveOrUpdate(second.before);
  } catch (error) {
    return {
      kind: "broken",
      message:
        `「${first.before.name}」は元に戻しましたが、「${second.before.name}」を戻せませんでした。` +
        `${messageOf(error)}\n「${second.before.name}」の記録には「${first.before.name}」は別人だという印が残っているので、` +
        "2人はまだ重複の候補に出ません。",
    };
  }

  const strippedNote = ticket.strippedAliases
    .map(
      (entry) =>
        `「${entry.name}」の別名 ${entry.aliases.map((alias) => `「${alias}」`).join("")} も戻しました。`
    )
    .join("");
  const pendingNote = await restorePending(
    pending,
    [],
    ticket.pendingBefore,
    first.before.name,
    second.before.name
  );
  return {
    kind: "done",
    band:
      `別人として覚えたのを取り消しました。「${first.before.name}」と「${second.before.name}」は、また重複の候補に出ます。` +
      strippedNote +
      pendingNote,
  };
}

/**
 * 片づけた・寄せた反映待ちを元の姿で積み直す。**失敗しても戻しは成り立っている**ので投げず、文で返す
 */
async function restorePending(
  pending: PendingCharacterWriter,
  after: readonly PendingUpdate[],
  before: readonly PendingUpdate[],
  firstName: string,
  secondName: string
): Promise<string> {
  if (after.length === 0 && before.length === 0) return "";
  try {
    for (const update of after) await pending.discard(update.filePath);
    for (const update of before) await restagePendingUpdate(pending, update);
  } catch (error) {
    return (
      `反映待ちの更新は戻せませんでした（${messageOf(error)}）。` +
      `「${firstName}」と「${secondName}」の更新案は、反映せずに退けてください。`
    );
  }
  return before.length > 0
    ? `反映待ちの更新 ${before.length}件も、元の姿で積み直しました。`
    : "";
}

/** 反映待ちが、控えたときのままか（読み直した写しどうしで比べる） */
function samePendingUpdates(
  current: readonly PendingUpdate[],
  expected: readonly PendingUpdate[]
): boolean {
  const key = (update: PendingUpdate): string =>
    JSON.stringify([
      update.filePath,
      update.kind ?? null,
      update.source ?? null,
      update.reason ?? null,
      update.character,
    ]);
  const left = current.map(key).sort();
  const right = expected.map(key).sort();
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * 書き換えが途中まで進んだ失敗か（`CharacterStoreError.persistenceState`）。
 * `characterStore.ts` を読み込むと vscode まで付いてくるので、形で見分ける
 */
function isAmbiguous(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { persistenceState?: unknown }).persistenceState === "ambiguous"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
