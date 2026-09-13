import type { AddressTerm, Character } from "../models/character";
import {
  addressEntryKey,
  aliasEntryKey,
  relationEntryKey,
} from "./characterDiff";

/**
 * 更新案の中の「1つだけ」を落としてから保存する（作者の依頼、2026-09-12）。
 *
 * 「呼称にハヤブサ先生があり、これが間違いです。この画面でここだけ
 * 消したりできないでしょうか？」——それまでは、レコードまるごと見送るか、
 * 間違ったまま反映するかの二択しかなかった。
 *
 * **落とすのは反映の直前、メモリの上だけ。** 承認待ちのファイル
 * （`PendingUpdate`）の形は変えない——作者が画面で付けた印は、
 * その1回の「反映する」にだけ効く判断である。
 *
 * **鍵は文字列として分解しない。** レコード側から `characterDiff` と
 * 同じ関数で鍵を組み立て、集合に入っているかだけを見る。分解すると、
 * 名前や呼び方に区切り文字（`:`）が入ったときに引き当てを外す。
 */

export interface DropResult {
  character: Character;
  /**
   * 実際に落とした葉の数。
   *
   * **黙って落としたことにしない**（CLAUDE.md 規則2）。作者へ
   * 「◯件を落として反映しました」と伝えるために数える。
   */
  dropped: number;
}

export function dropDiffEntries(
  character: Character,
  keys: readonly string[]
): DropResult {
  if (keys.length === 0) return { character, dropped: 0 };

  const drop = new Set(keys);
  let dropped = 0;

  const addressTerms: AddressTerm[] = [];
  for (const term of character.addressTerms) {
    // 作者が固定した呼称は変更しない（CLAUDE.md 規則2）。
    // 画面でも ✕ を出していないが、ここでも受け付けない
    if (term.authorLocked) {
      addressTerms.push(term);
      continue;
    }
    const forms = term.forms.filter(
      (form) => !drop.has(addressEntryKey(term.targetName, form.term))
    );
    const removed = term.forms.length - forms.length;
    if (removed === 0) {
      addressTerms.push(term);
      continue;
    }
    dropped += removed;
    // **呼び方が全部落ちたら、その相手の項目ごと消す。** 誰も呼んでいない
    // 相手が資料に残ると、次の抽出が「呼び方が抜けている」と読み直す
    if (forms.length === 0) continue;
    addressTerms.push({ ...term, forms });
  }

  const relations = character.relations.filter(
    (relation) => !drop.has(relationEntryKey(relation.name, relation.relation))
  );
  dropped += character.relations.length - relations.length;

  const aliases = character.aliases.filter(
    (alias) => !drop.has(aliasEntryKey(alias))
  );
  dropped += character.aliases.length - aliases.length;

  // 1つも当たらなかったなら、写しを作らずそのまま返す
  if (dropped === 0) return { character, dropped: 0 };

  return { character: { ...character, addressTerms, relations, aliases }, dropped };
}
