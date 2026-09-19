/**
 * 名前に付く敬称の扱い（設計書6.5.9）。
 *
 * **敬称の一覧はここにしか置かない。** `characterMerge` の `normalizeName` も
 * この一覧を借りる。写しを作ると、片方にだけ敬称を足したときに
 * 「片方の判定では同一人物、もう片方では別人」という食い違いが起きる。
 *
 * ここは純粋関数だけを置く。VSCode API にもファイル操作にも依存しない。
 */

/**
 * 名前の後ろに付く敬称。**同一人物判定でのみ使い、
 * name / aliases に保存する文字列からは取り除かない**
 * （呼び分けそのものが addressTerms の管理対象であるため）。
 *
 * 「殿下」と「妃殿下」のように一方が他方の末尾になる組があるため、
 * 照合は長い敬称から行う（`HONORIFIC_SUFFIXES` を参照）。
 * 並び順に依存しないよう、定義はここでは自由に足してよい。
 *
 * 「先生」は敬称として名前に付く（「マイナ先生」＝「マイナ」）。
 * 「先生」単独は GENERIC_ROLES 側で人物名から除外されるため、
 * ここに入れても役職語だけのレコードを拾うことはない。
 */
/**
 * 貴族の称号（爵位）。**個人ではなく家に付く。**
 *
 * 敬称として外す理由は「ヴォイド・コンストラクタ男爵」と
 * 「ヴォイド・コンストラクタ」を別人扱いしないため。**「夫人」付きも落とす**
 * （「ジェクティ・コンストラクタ男爵夫人」＝「ジェクティ・コンストラクタ」）。
 *
 * **個人に付く敬称と分けて持つのは、名寄せが両者を区別するためである。**
 * 「リナちゃん」から「ちゃん」を外した「リナ」は個人の名前だが、
 * 「シーゲン子爵」から「子爵」を外した「シーゲン」は家名である。
 * 家名は同一人物の証拠にならないので、部分一致の手掛かりにしてはいけない
 * （`characterMerge.sharedNameParts`。2026-09-19に父が娘を吸収した）。
 */
export const NOBILITY_TITLE_SOURCE = [
  "大公爵夫人",
  "公爵夫人",
  "侯爵夫人",
  "伯爵夫人",
  "子爵夫人",
  "男爵夫人",
  "大公爵",
  "公爵",
  "侯爵",
  "伯爵",
  "子爵",
  "男爵",
];

export const HONORIFIC_SUFFIX_SOURCE = [
  // 一般
  "さん",
  "くん",
  "君",
  "ちゃん",
  "ちゃま",
  "様",
  "さま",
  "殿",
  "氏",
  "女史",
  // 立場・職能
  "先輩",
  "先生",
  "師",
  "卿",
  "翁",
  // 王侯貴族・聖職
  "陛下",
  "妃殿下",
  "殿下",
  "閣下",
  "猊下",
  "聖下",
  "姫",
  "公",
  // 爵位は下の `NOBILITY_TITLE_SOURCE` が持つ（写しを作らない）
  ...NOBILITY_TITLE_SOURCE,
];

/**
 * 長い敬称から順に照合する。
 *
 * 「エレナ妃殿下」は「殿下」でも末尾一致するため、
 * 短い方を先に試すと「エレナ妃」が残ってしまう。
 */
export const HONORIFIC_SUFFIXES = [...HONORIFIC_SUFFIX_SOURCE].sort(
  (a, b) => b.length - a.length
);

/**
 * 敬称を外した残りに、これだけの長さが要る。
 *
 * 1字だと「姫」「公」のような敬称そのもの1語や、
 * 「母さん」→「母」のように呼び名として成り立たない形が残る。
 */
const MIN_REMAINDER_LENGTH = 2;

/**
 * 呼びかけ語の頭に付く「お」「ご」「御」。
 *
 * ここで止めないと「おじいさま」→「おじい」、「お嬢様」→「お嬢」という、
 * 作中の誰も使わない形になる。**敬称込みでひとつの呼びかけ語**である。
 */
const POLITE_PREFIX = /^[おご御]/u;

/**
 * 名前の末尾の敬称を1つだけ外す（設計書6.5.9）。
 *
 * **外すのは1つだけ。** 「〇〇様様」のような重ねは呼び方そのものなので、
 * 繰り返し剥がすと別の語になる。
 *
 * 外さない場合（そのまま返す）:
 *  - 残りが2字未満（「先生」「姫」——敬称だけで呼ぶ語）
 *  - 残りが「お」「ご」「御」で始まる（「おじいさま」「お嬢様」）
 *
 * **保存する名前はこの形にしない。** 作者の書き方をそのまま残す。
 */
export function stripHonorific(name: string): string {
  const base = name.trim();
  for (const suffix of HONORIFIC_SUFFIXES) {
    if (!base.endsWith(suffix)) continue;
    const rest = base.slice(0, base.length - suffix.length);
    if (rest.length < MIN_REMAINDER_LENGTH) return base;
    if (POLITE_PREFIX.test(rest)) return base;
    return rest;
  }
  return base;
}

/** 敬称が付いているか（外せる形か） */
export function hasHonorific(name: string): boolean {
  return stripHonorific(name) !== name.trim();
}
