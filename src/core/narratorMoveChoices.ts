import type { Character } from "../models/character";
import type { NarratorMoveChoice, NarratorMoveItem, NarratorMoveOutcome } from "./narratorMoves";

/**
 * 語り手の取り違えを移す案の、画面とのやり取りと知らせの文（設計書6.5.12）。
 *
 * もとは `features/settingsPanel.ts` と `features/narratorMovePending.ts` に置いていた。
 * モバイル版（novel-ai-mobile）が同じ決まりで使えるように、`vscode` を読まない
 * core へ移した（2026-11-22。動きは変えていない）。ファイルを消す操作は呼び出し側に残す
 * （VS Code はワークスペースの fs、モバイル版は自分の置き場で消す）。
 */

/**
 * 移す案の鍵の印（2026-10-10、0.102.2）。鍵は「印＋控えの位置」
 * ——`narratorMove:3`。値は移し先の人物の id（空なら外すだけ）。
 * 画面は鍵の中身を見ずにそのまま送り返してくる
 */
export const NARRATOR_MOVE_PREFIX = "narratorMove:";

/**
 * 画面から返った移す案の選び（鍵と移し先の id）を、控えの案に引き当てる。
 * **移し先はその案の候補にあるものだけを通す**（画面から返った id で、候補に
 * 無い人物の資料を書き換えない）。候補に無い id・控えに無い位置は落とす
 */
export function narratorMoveChoicesOf(
  values: Record<string, string>,
  items: readonly NarratorMoveItem[]
): NarratorMoveChoice[] {
  const choices: NarratorMoveChoice[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(NARRATOR_MOVE_PREFIX)) continue;
    const index = Number(key.slice(NARRATOR_MOVE_PREFIX.length));
    const item = Number.isSafeInteger(index) ? items[index] : undefined;
    if (!item) continue;
    const wanted = value.trim();
    if (wanted && !item.destination.candidates.some((candidate) => candidate.id === wanted)) {
      continue;
    }
    choices.push({ item, destinationId: wanted || null });
  }
  return choices;
}

/**
 * 移す案を反映した結果の知らせ。**黙って据え置いたことにしない**——移した数・
 * 外すだけにした数・見つからなかった数と、移し先の値を上書きしなかったことを書く
 */
export function describeMoveOutcome(
  outcome: Pick<NarratorMoveOutcome, "destinations" | "moved" | "removedOnly" | "missing" | "notes">,
  people: readonly Character[]
): string {
  const parts: string[] = [];
  if (outcome.moved > 0) {
    const names = outcome.destinations
      .map((destination) => people.find((person) => person.id === destination.id)?.name ?? destination.name)
      .map((name) => `「${name}」`)
      .join("・");
    parts.push(`${outcome.moved} 件を${names}の資料へ移しました。`);
  }
  if (outcome.removedOnly > 0) {
    parts.push(`${outcome.removedOnly} 件は移し先を選ばなかったので、外すだけにしました。`);
  }
  if (outcome.missing > 0) {
    parts.push(
      `${outcome.missing} 件はいまの資料に見つからなかったので、何もしていません（別の窓で直されたのかもしれません）。`
    );
  }
  if (outcome.moved + outcome.removedOnly > 0) {
    parts.push(
      "外した項目の値と関係は、退けた記録に残しました（次の抽出が同じ値を積み戻さないため）。"
    );
  }
  parts.push(...outcome.notes);
  return parts.join("");
}

/** 片づけを決めるのに要る、承認待ちの更新案の形（`PendingUpdate` のうち読む欄だけ） */
export interface StaleUpdateCandidate {
  kind?: string;
  filePath: string;
  character: { id: string };
}

/** 片づける更新案のファイルと、片づけた人物の名前 */
export interface StaleCharacterUpdates {
  filePaths: string[];
  names: string[];
}

/**
 * 移したあとの人物の、承認待ちの更新案のうち片づけるものを選ぶ（0.102.4）。
 *
 * 更新案は**レコード丸ごとの写し**なので、移す前の写しを承認すると移した値が戻る。
 * 写しから移した値だけを抜く道は取らず、その人物の更新案を丸ごと片づける
 * （理由は `features/narratorMovePending.ts` の `discardStaleCharacterUpdates`）。
 * 新しく作る案（`kind: "creation"`）は仮IDなので照らさない。
 *
 * **ここでは何も消さない。** 返したファイルを消すのは呼び出し側
 */
export function staleCharacterUpdates(
  updates: readonly StaleUpdateCandidate[],
  people: readonly Pick<Character, "id" | "name">[]
): StaleCharacterUpdates {
  const filePaths: string[] = [];
  const names: string[] = [];
  for (const person of people) {
    const stale = updates.filter(
      (update) => update.kind !== "creation" && update.character.id === person.id
    );
    if (stale.length === 0) continue;
    filePaths.push(...stale.map((update) => update.filePath));
    names.push(person.name);
  }
  return { filePaths, names };
}

/**
 * 片づけたことの知らせ（反映の知らせに1行。黙って消したことにしない）。
 * 片づけが無ければ null。
 */
export function describeDiscardedUpdatesNotice(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return (
    `${names.map((name) => `「${name}」`).join("")}の承認待ちの更新案を片づけました` +
    "（移す前の写しなので、承認すると移した値が戻るため）。" +
    "もう一度「設定資料を抽出」すると作り直されます。"
  );
}
