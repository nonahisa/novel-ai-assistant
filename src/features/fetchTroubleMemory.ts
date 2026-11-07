import type * as vscode from "vscode";

/**
 * 編集者の側で「置き場に届きません」をもう知らせた作品を覚える（設計書5.7.5.4。作者の決定 2026-11-07）。
 *
 * 開いたときの自動の取りに行きは見張りのたびに走る。解除されたあとは毎回失敗するので、
 * 覚えずに出すと同じ知らせが何度も出る。**同じ作品で1回だけ**知らせ、取りに行きが通ったら
 * 忘れる（次にまた届かなくなったら、また知らせる）。
 *
 * **覚えは拡張機能の保管（`globalState`）に置く。** 作品フォルダーに書くと、編集者の写しに
 * 記録されない変更が増え、取り込みを止める（`decisionMemory.ts` と同じ理由）。
 * 書くのは確かめる包み（`verifiedState`。設計書5.7.8）を通した保管で、`extension.ts` が起動時に
 * 1回だけ渡す。消えても起きるのは同じ知らせがもう一度出ることだけ。
 */

const STORAGE_KEY = "novelai.editorUnreachableNotified";

let memento: vscode.Memento | undefined;

export function rememberFetchTroubleMemory(storage: vscode.Memento): void {
  memento = storage;
}

/** 試験で差し替えられる口 */
export interface FetchTroubleMemory {
  has(workId: string): boolean;
  mark(workId: string): Promise<void>;
  clear(workId: string): Promise<void>;
}

function readIds(): string[] {
  const value = memento?.get<string[]>(STORAGE_KEY);
  return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
}

/** 書く口は1か所（`mementoWrites.test.ts` が見張る） */
async function writeIds(ids: string[]): Promise<void> {
  if (!memento) return;
  await memento.update(STORAGE_KEY, ids);
}

export const globalFetchTroubleMemory: FetchTroubleMemory = {
  has(workId) {
    return readIds().includes(workId);
  },
  async mark(workId) {
    const ids = readIds();
    if (ids.includes(workId)) return;
    await writeIds([...ids, workId]);
  },
  async clear(workId) {
    const ids = readIds();
    // 書かずに済むときは書かない（取りに行きが通るたびに保管へ書くと、ほかの鍵の
    // 書き戻しとぶつかる機会が増える。設計書5.7.8）
    if (!ids.includes(workId)) return;
    await writeIds(ids.filter((id) => id !== workId));
  },
};
