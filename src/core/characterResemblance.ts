import type { Character, CharacterTextField } from "../models/character";

/**
 * 抽出した値が、**同じ作品の別の人物の記述**に似ているか（精査 F4、
 * 作者の判断 2026-09-25「別人の記述に似ているときだけ止める」。設計書6.18）。
 *
 * ## 何が起きていたか
 *
 * 実データで、コリンナ（メイド）の第1話の資料にナイン（主人）の記述が混ざった。
 * 同じ場面から2人ぶんの記述が出て、片方がコリンナにも書き込まれたとみられる
 * （第1話は語り手がまだ2人の名前を知らない場面）。混ざった値は
 * 「不死妃の宮の主。かつて王妃であった**金髪のエルフ**。」と
 * 「不死妃の宮の主。かつて王妃であった**エルフの女性**。」のように、
 * **言い回しがわずかに違うだけの同じ内容**だった。
 *
 * マージは違う話の値を「作中の変化」として積むので、コリンナの年表に
 * 起きていない変化が載った。**別人の記述と照らし合わせれば、機械でも気づける。**
 * AIは要らない。
 *
 * ## 何と比べるか
 *
 * - **同じ話の、別の人物の、同じ項目の値だけ。** 別の話の値と似ていても、
 *   同じ場面から2人ぶんが出たとは言えない。話数で絞らないと、
 *   「冒険者ギルド西門支部の職員」と「同じ支部の責任者」のように、
 *   同じ所に属する別人の記述で止まる
 * - **作者が認めた記述と、抽出が積んだ変化の記録だけを見る。** 食い違い
 *   （作者の判断待ち）の値は見ない。見ると、コリンナ側に止めた値を理由に、
 *   今度は持ち主のナインの記述まで止めてしまう
 * - **本人の記述のほうに似ていれば止めない。** 2人が同じように描かれた場面
 *   （同じ所に勤める2人など）で、本人の読みまで止めないため
 *
 * ## 照合する項目
 *
 * **紹介文と外見だけ。** 所属・役割・性別は、別人と同じ値が当たり前にある
 * （「冒険者ギルド」「学生」「女性」）。作者の作品の写しで数えると、
 * 別人と同じ所属・役割の値が百件を超え、照合するとそれがみな止まる。
 * 性格・口調は面として積む項目で、「作中の変化」には積まない
 * （止めた値の置き場所が別に要るので、ここでは扱わない。設計書6.18）。
 *
 * VS Code APIに依存しない。
 */

/** 照合する項目。理由は冒頭の「照合する項目」 */
export const RESEMBLANCE_FIELDS: ReadonlySet<CharacterTextField> = new Set<
  CharacterTextField
>(["summary", "appearance"]);

/**
 * これ以上似ていたら「別人の記述に似ている」とみなす（0〜1）。
 *
 * **作者の作品の写し4作（人物73人）で数えて決めた**（設計書6.18）。
 * 紹介文と外見で、同じ話・別の人物・本人より似ている、の3つを満たす値は
 * 0.5 でも 0.6 でも同じ10件で、0.4 に下げると12件に増える。実データで
 * 混ざった値は 0.81（紹介文）・0.65（外見）で、0.6 だと外見が際どい。
 * 件数が増えない範囲のいちばん低い 0.5 にした。
 *
 * 同じ話の同じ人物の読み直しどうしは、中央で 0.26 しか似ていない
 * （AIは読むたびに言い換える）。**独立に読み直した言い換えは、この照合では
 * 捕まらない。** 捕まえるのは、1回の抽出で同じ場面から2人ぶんの記述が
 * ほぼ同じ言葉で出た取り違え（F4 の実例）である。
 */
export const RESEMBLANCE_THRESHOLD = 0.5;

/**
 * 比べる前に落とす文字。句読点・括弧・記号・空白は、言い回しの揺れでよく
 * 入れ替わるが、中身の違いではない（「着ている。」と「着用している」）。
 */
const IGNORED_MARKS =
  /[\s、。，．,.・「」『』（）()［］[\]【】〈〉《》!！?？:：;；／/～〜ー―—…‥"'“”‘’-]/gu;

function comparable(text: string): string {
  return text.normalize("NFKC").replace(IGNORED_MARKS, "");
}

/** 2文字ずつの切れ端。1文字しか無ければその1文字 */
function bigrams(text: string): Set<string> {
  if (text.length <= 1) return new Set(text ? [text] : []);
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index++) {
    grams.add(text.slice(index, index + 2));
  }
  return grams;
}

/**
 * 2つの記述がどれだけ似ているか（0〜1）。
 *
 * 2文字ずつの切れ端の重なり（Dice係数）で測る。日本語は単語の区切りが無く、
 * 言い回しの揺れ（「着ている」「着用している」）は語の一部だけが変わるので、
 * 単語単位より切れ端のほうが揺れに強い。**長さの違いは差し引かれる**——
 * 短い記述が長い記述に含まれるだけで満点にすると、「黒髪」のような短い値が
 * 誰の記述にも似てしまう。
 */
export function textSimilarity(left: string, right: string): number {
  const a = comparable(left);
  const b = comparable(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared++;
  return (2 * shared) / (gramsA.size + gramsB.size);
}

/** 話数が1つでも重なるか */
function sharesChapter(left: readonly number[], right: readonly number[]): boolean {
  const seen = new Set(left);
  return right.some((chapter) => seen.has(chapter));
}

/**
 * 本人の、その項目の記述（本体と変化の記録）。比べる相手の値は除く。
 * 食い違い（判断待ち）の値は入れない——他人に似て止めた値も含まれている。
 */
function ownValues(
  target: Character,
  field: CharacterTextField,
  value: string
): string[] {
  const values = new Set<string>();
  const current = target[field];
  if (typeof current === "string" && current.trim()) values.add(current.trim());
  for (const change of target.changes) {
    if (change.field === field && change.value.trim()) values.add(change.value.trim());
  }
  values.delete(value);
  return [...values];
}

/** 似ていた相手 */
export interface Resemblance {
  /** 似ていた人物の名前（資料に「〇〇の記述と似ています」と出す） */
  name: string;
  /** 似ていた記述 */
  value: string;
  /** 似かた（0〜1） */
  score: number;
}

/**
 * 新しい値が、同じ話の別の人物の同じ項目の記述に似ていれば、その相手を返す。
 * 似ていなければ undefined。照合しない項目・話数の分からない値も undefined。
 */
export function findResemblingCharacter(
  target: Character,
  others: readonly Character[],
  field: CharacterTextField,
  value: string,
  chapters: readonly number[]
): Resemblance | undefined {
  if (!RESEMBLANCE_FIELDS.has(field)) return undefined;
  const text = value.trim();
  if (!text || chapters.length === 0) return undefined;

  let best: Resemblance | undefined;
  for (const other of others) {
    if (other.id === target.id) continue;
    for (const change of other.changes) {
      if (change.field !== field) continue;
      // 同じ話の記述だけ。話数の分からない値は、同じ場面かどうか決められない
      if (!sharesChapter(change.chapters, chapters)) continue;
      const score = textSimilarity(text, change.value);
      if (score >= RESEMBLANCE_THRESHOLD && (!best || score > best.score)) {
        best = { name: other.name, value: change.value, score };
      }
    }
  }
  if (!best) return undefined;

  // 本人の記述のほうに似ている（同じくらい似ている）なら、本人の読みとみなす
  const own = Math.max(
    0,
    ...ownValues(target, field, text).map((entry) => textSimilarity(text, entry))
  );
  return best.score > own ? best : undefined;
}

/** 資料に添える一言（「ナインの記述と似ています」） */
export function describeResemblance(name: string): string {
  return `${name}の記述と似ています`;
}
