// 互いに import し合う（検算が呼ぶ）が、関数の中でしか使わないので読み込み順に依らない
import { isMeaningfulValue } from "./characterExtractionValidation";

/**
 * 呼称の区分（`AddressForm.category`）の案内（P-04a 5.12。作者の裁定 2026-10-26）。
 *
 * スキーマに欄があるだけで説明が無く、AIは何を書けばよいか分からなかった。
 * **頼み方と検算が同じ表を見る**（`WORLD_THING_GUIDES` と同じ形）——説明の文が
 * そのまま値に返ってきたときに、検算が写しだと見分けられるようにするため。
 *
 * **区分の名前は決め打ちの選択肢（enum）にしていない。** 資料の型は自由記述
 * （`string | null`）で、設計書の例（「名前呼び捨て」）のような作品側の言い方も
 * 受け取ってきた。enum にするなら型と画面も動くので、作者の裁定を待つ。
 *
 * 説明に固有の呼び名を置かない（例の語は本文に無いまま返ってくる。失敗3）。
 */
export const ADDRESS_CATEGORY_GUIDES: ReadonlyArray<{
  label: string;
  meaning: string;
}> = [
  { label: "姓＋敬称", meaning: "姓に敬称や接尾辞が付いた呼び方" },
  { label: "名＋敬称", meaning: "下の名前に敬称や接尾辞が付いた呼び方" },
  { label: "姓の呼び捨て", meaning: "姓だけで呼ぶ" },
  { label: "名の呼び捨て", meaning: "下の名前だけで呼ぶ" },
  { label: "フルネーム", meaning: "姓と名の両方で呼ぶ" },
  { label: "あだ名", meaning: "本名を縮めた・崩した呼び方や愛称" },
  { label: "役職", meaning: "役職・肩書き・職業で呼ぶ" },
  { label: "続柄", meaning: "家族・親族の続柄で呼ぶ" },
];

/** 指示の文にしか出ない言い回し。値に入っていたら指示の写しである */
const INSTRUCTION_ECHO = /区分|当たらなければ/u;

/**
 * AIが返した呼称の区分を、資料に入れてよい形にする。入れないものは null。
 *
 * 落とすのは「中身が無い」か「指示の写し」だけで、表に無い言い方は残す
 * （上の注記のとおり、自由記述を受け取ってきたため）。
 */
export function cleanAddressCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !isMeaningfulValue(text)) return null;
  if (INSTRUCTION_ECHO.test(text)) return null;
  // 説明の部分を写した形（「姓＋敬称：姓に敬称や…」も、説明だけの形も）
  if (ADDRESS_CATEGORY_GUIDES.some((guide) => text.includes(guide.meaning))) {
    return null;
  }
  // 区分名を2つ以上並べた形は、1つを選べていない（一覧の写し）。
  // **区切りで割った欠片が区分名と丸ごと一致するものだけを数える**——包含で数えると、
  // 「あだ名＋敬称」が「あだ名」と「名＋敬称」の2つに当たり、正当な組み合わせを落とす
  const pieces = text.split(/[／/、・，,\s]+/u).filter((piece) => piece);
  const labels = pieces.filter((piece) =>
    ADDRESS_CATEGORY_GUIDES.some((guide) => guide.label === piece)
  );
  if (labels.length >= 2) return null;
  return text;
}
