/**
 * 禁則処理の文字の定義（PDF出力。設計書6.33.5）。
 *
 * **定義はこのファイルだけに置く。** 印刷用HTMLのページ割り（ブラウザの中で
 * 動く `printPaginate.ts` のスクリプト）と、公募の納品用の行割り
 * （`manuscriptGrid.ts`）の両方がここを見る。写しを置くと、紙の種類に
 * よって禁則の決まりが食い違う日が来る。
 *
 * ## どこまでを禁則にするか
 *
 * 作者の依頼は「行頭の句読点・閉じ括弧、行末の開き括弧、ぶら下げ」である
 * （2026-09-21）。
 *
 * **紙の種類で、ゆるい側と厳しい側を使い分ける**（作者の裁定、2026-10-09）。
 *
 * - **ゆるい側（`NO_LINE_START`）＝公募の納品用の升目（`manuscriptGrid.ts`）。**
 *   原稿用紙の書き方（公募の多くが前提にしている）に合わせ、**小さい仮名
 *   （ぁ・っ・ャ）と長音（ー）は行頭に来てよい**。ここを厳しくすると、1行の
 *   字数が指定より短い行が増え、公募の「40字×40行」から外れて見える
 * - **厳しい側（`NO_LINE_START_STRICT`）＝文庫などの読む紙（`printPaginate.ts`
 *   の面の切れ目と、`printHtml.ts` の `line-break: strict`）。** 小さい仮名と
 *   長音も行頭に置かない。市販の本の組み方で、実機の写真では文庫の2ページ目の
 *   頭が「った。」から始まっていた。読む紙は1行の字数が決まっていないので、
 *   厳しくしても困らない
 *
 * VS Code API に依存しない（ブラウザ版でも、テストでもそのまま動く）。
 */

/**
 * 行の頭に置かない字。
 *
 * - 句読点（、。，．と半角の , .）
 * - 閉じ括弧（」』）］｝〕〉》】〙〗〟’” と半角の ) ] }）
 * - 区切りの約物（！？‼⁇⁈⁉・：；と半角の ! ? : ;）
 * - 繰り返しの記号（々ゝゞヽヾ〻）——前の字を指すので、前の字と離さない
 */
export const NO_LINE_START =
  "、。，．,." +
  "」』）］｝〕〉》】〙〗〟’”)]}｠»" +
  "！？‼⁇⁈⁉・：；!?:;" +
  "々ゝゞヽヾ〻";

/**
 * 小さい仮名と長音（厳しい側だけが行頭に置かない字）。
 *
 * ひらがな（ぁぃぅぇぉっゃゅょゎゕゖ）・カタカナ（ァィゥェォッャュョヮヵヶ）・
 * アイヌ語用の小さいカタカナ（ㇰ〜ㇿ。U+31F0〜U+31FF）と、長音の「ー」。
 */
export const SMALL_KANA_AND_PROLONGED =
  "ぁぃぅぇぉっゃゅょゎゕゖ" +
  "ァィゥェォッャュョヮヵヶ" +
  "ㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ" +
  "ー";

/** 読む紙（文庫など）で行の頭に置かない字。ゆるい側に小さい仮名と長音を足したもの */
export const NO_LINE_START_STRICT = NO_LINE_START + SMALL_KANA_AND_PROLONGED;

/** 行の終わりに置かない字（開き括弧） */
export const NO_LINE_END = "「『（［｛〔〈《【〘〖〝‘“([{｟«";

/**
 * ぶら下げてよい字（句読点だけ）。
 *
 * **閉じ括弧はぶら下げない。** 原稿用紙の書き方では、行末からはみ出して
 * 書いてよいのは句読点だけで、閉じ括弧は前の字ごと次の行へ送る。
 */
export const HANGABLE = "、。，．,.";

/** 1文字（先頭の字）が行頭に来てはいけない字か */
export function isNoLineStart(text: string): boolean {
  return text !== "" && NO_LINE_START.includes(firstChar(text));
}

/** 読む紙の厳しい側で、1文字（先頭の字）が行頭に来てはいけない字か */
export function isNoLineStartStrict(text: string): boolean {
  return text !== "" && NO_LINE_START_STRICT.includes(firstChar(text));
}

/** 1文字（末尾の字）が行末に来てはいけない字か */
export function isNoLineEnd(text: string): boolean {
  return text !== "" && NO_LINE_END.includes(lastChar(text));
}

/** ぶら下げてよい字か（1文字として見る） */
export function isHangable(text: string): boolean {
  return [...text].length === 1 && HANGABLE.includes(text);
}

function firstChar(text: string): string {
  return [...text][0] ?? "";
}

function lastChar(text: string): string {
  const chars = [...text];
  return chars[chars.length - 1] ?? "";
}
