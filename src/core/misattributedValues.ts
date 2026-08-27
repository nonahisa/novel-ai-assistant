import {
  emptyCharacter,
  isCharacterTextField,
  nextCharacterId,
  type Character,
} from "../models/character";
import {
  insertFieldValue,
  normalizeName,
  type FieldInsertResult,
} from "./characterMerge";
import { isMeaningfulValue } from "./characterExtractionValidation";
import { isGroundedInChunk } from "./groundedEvidence";
import { fillReading } from "./reading";

/**
 * 「AIで再読込」ではじいた記述の受け皿（設計書6.31.2）。
 *
 * 実データで、アジャーノの記録に皇子の場面の記述が入っていた（6.5.8の5行目）。
 * 混入を防ぐ手当ては入ったが、**既に混ざったレコードは直らない。**
 * 作者の留意点つきで読み直させ、AIが「これは別人のものだ」と分けた記述を
 * ここで受ける。
 *
 * ## 捨てない。ただし、そのままも書かない
 *
 * AIが返した文字列を、そのまま別のレコードへ書き込むことはしない。
 *   1. 根拠（逐語引用）が本文の抜粋に実在するかを照合する
 *   2. 行き先（belongsTo）は**コードで既存レコードと突き合わせる**
 *   3. 実際に書くのは、作者がボタンを押したときだけ
 *
 * 照合に落ちたものは黙って消さず、件数を作者へ返す。
 * 「はじいた件数」が分からないと、何も出なかったのが
 * 「混入が無かった」のか「照合で全部落ちた」のか区別できない。
 *
 * ここはファイルにも vscode にも触らない（`characterSeparate.ts` と同じ方針）。
 */

/** AIが「この記録のものではない」と分けた1件 */
export interface MisattributedValue {
  /** 誰のものか。本文で使われている呼び名 */
  belongsTo: string;
  /** どの項目の値か。設定資料の項目キー */
  field: string;
  /** その項目に入る値 */
  value: string;
  /** 本文からの逐語引用 */
  evidence: string;
}

/** 除いた件数と、その理由。黙って捨てないために数える */
export interface MisattributedDropCounts {
  /** 逐語引用（または呼び名）を本文の抜粋と照合できなかった */
  ungrounded: number;
  /** 設定資料に存在しない項目名を返してきた */
  unknownField: number;
  /** 値が空、または「不明」のような中身の無い文言だった */
  emptyValue: number;
  /** 形が違う（項目が欠けている・文字列でない） */
  malformed: number;
}

export interface MisattributedParseResult {
  entries: MisattributedValue[];
  dropped: MisattributedDropCounts;
}

/** 除いた合計。作者へ「n件は除きました」と伝えるのに使う */
export function droppedTotal(dropped: MisattributedDropCounts): number {
  return (
    dropped.ungrounded +
    dropped.unknownField +
    dropped.emptyValue +
    dropped.malformed
  );
}

/**
 * 応答の `misattributed` を読む。
 *
 * @param raw           応答のその項目（何が来るか分からないので unknown）
 * @param excerptText   AIへ渡した本文の抜粋を繋げたもの。逐語照合に使う
 * @param allowedFields 設定資料に実在する項目キー
 */
export function parseMisattributedValues(
  raw: unknown,
  excerptText: string,
  allowedFields: readonly string[]
): MisattributedParseResult {
  const dropped: MisattributedDropCounts = {
    ungrounded: 0,
    unknownField: 0,
    emptyValue: 0,
    malformed: 0,
  };
  if (!Array.isArray(raw)) return { entries: [], dropped };

  const allowed = new Set(allowedFields);
  const entries: MisattributedValue[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      dropped.malformed++;
      continue;
    }
    const record = item as Record<string, unknown>;
    const belongsTo = text(record.belongsTo);
    const field = text(record.field);
    const value = text(record.value);
    const evidence = text(record.evidence);

    if (!belongsTo || !field || !evidence) {
      dropped.malformed++;
      continue;
    }
    // 「不明」「記述なし」を値として返してくるのは、この作品で繰り返し
    // 起きている失敗。挿入先のレコードへ載る手前で落とす
    if (!isMeaningfulValue(value)) {
      dropped.emptyValue++;
      continue;
    }
    if (!allowed.has(field)) {
      dropped.unknownField++;
      continue;
    }
    // 呼び名と逐語引用の両方が本文の抜粋にあること。
    // 判定は抽出と共有する（片方だけ直しても、もう片方から入り込む）
    if (!isGroundedInChunk([belongsTo], evidence, excerptText)) {
      dropped.ungrounded++;
      continue;
    }

    entries.push({ belongsTo, field, value, evidence });
  }

  return { entries, dropped };
}

/** 行き先。既存レコードに当たったときだけ id を持つ */
export type MisattributedDestination =
  | { kind: "existing"; id: string; name: string }
  | { kind: "new"; name: string };

/** 照合に使う最小限の形。テストから人物レコード全体を組み立てずに済ませる */
export interface NamedRecord {
  id: string;
  name: string;
  aliases: readonly string[];
}

/**
 * 行き先を決める。**AIの返した文字列を、そのまま書き込み先にしない。**
 *
 * 名前と別名を、敬称を落とした形で突き合わせる（`normalizeName`）。
 * 「殿下」と「殿下様」を別人扱いしないためで、抽出側と同じ規則である。
 *
 * 名前での一致を先に見る。別名は複数のレコードに同じものが残っていることが
 * あり（まとめ損ねた記録など）、そちらを先に採ると本人以外へ入りかねない。
 */
export function resolveMisattributedDestination(
  belongsTo: string,
  characters: readonly NamedRecord[]
): MisattributedDestination {
  const wanted = belongsTo.trim();
  const key = normalizeName(wanted);
  if (key) {
    const byName = characters.find(
      (character) => normalizeName(character.name) === key
    );
    if (byName) {
      return { kind: "existing", id: byName.id, name: byName.name };
    }
    const byAlias = characters.find((character) =>
      character.aliases.some((alias) => normalizeName(alias) === key)
    );
    if (byAlias) {
      return { kind: "existing", id: byAlias.id, name: byAlias.name };
    }
  }
  return { kind: "new", name: wanted };
}

/**
 * はじいた記述を、既存の人物へ入れる。
 *
 * 上書きはしない。空欄なら埋め、既に値があって食い違うなら
 * 「変化かもしれない」として作者の判断へ回す（`insertFieldValue`）。
 * 話数は分からないので渡さない——分からないまま付けると、
 * 起きていない変化が資料に載る。
 */
export function insertMisattributedValue(
  character: Character,
  entry: MisattributedValue
): FieldInsertResult {
  if (!isCharacterTextField(entry.field)) {
    throw new Error(`「${entry.field}」は登場人物の項目ではありません。`);
  }
  return insertFieldValue(character, entry.field, entry.value);
}

/**
 * はじいた記述だけを持つ、新しい人物を起こす。
 *
 * **その値以外は埋めない。** 中身は次の抽出で本文から入る
 * （`characterSeparate.ts` と同じ考え方）。`autoGenerated` を立てたままに
 * するのもそのためで、false にすると空の記録が永久に埋まらない。
 */
export function planMisattributedRecord(
  entry: MisattributedValue,
  all: readonly Character[]
): Character {
  const name = entry.belongsTo.trim();
  if (!name) throw new Error("行き先の呼び名が空です。");
  if (!isCharacterTextField(entry.field)) {
    throw new Error(`「${entry.field}」は登場人物の項目ではありません。`);
  }

  const created = emptyCharacter(nextCharacterId([...all]), name);
  created.reading = fillReading(null, name);
  // どこを読んでそう書いたのかを残す。AIが起こした記録は、
  // 根拠が無いと作者が確かめようがない
  created.evidence = entry.evidence;

  return insertFieldValue(created, entry.field, entry.value).character;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
