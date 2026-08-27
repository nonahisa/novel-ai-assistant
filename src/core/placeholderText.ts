/**
 * AIが「中身が無い」ことを、**中身として書いてくる**のを見つける。
 *
 * 2026-08-17、作者の10作品で推敲を測っていて見つかった。
 * プロンプトに「直し方が文体の書き換えになるものは、修正案を**空文字**に
 * してください」と書いたところ、`gemma4:e4b` が
 *
 *     "suggestion": "空文字"
 *
 * と返した。**「空文字」という3文字が修正案として入っている。**
 * そのまま「適用」を押すと、本文の一文がその3文字に置き換わる。
 * **原稿が壊れる。**
 *
 * プロンプト側の書き方も直したが、**言い方を変えても別の言い方で返ってくる**
 * ので、本文へ書き込む手前で必ずここを通す。指示の言葉を書いてくるのは
 * 空文字に限らない（`null`、`なし`、`変更不要` など）。
 */

/**
 * 中身のつもりで書かれた「中身が無い」という言葉。
 *
 * **本物の直しになりえないものだけを並べる。** たとえば「なし」は
 * 誤字脱字では本物の直しになりうるので（「無し」→「なし」）、
 * ここには入れず、置き換える範囲が広い推敲側でだけ足す。
 */
const PLACEHOLDERS = [
  "空文字",
  "空文字列",
  "空",
  "(空)",
  "（空）",
  "n/a",
  "na",
  "null",
  "undefined",
  "none",
  "変更なし",
  "変更不要",
  "修正なし",
  "修正不要",
  "修正案なし",
  "提案なし",
  "特になし",
  // 冒頭診断（P-24）のテストで抜けが発覚。誤字脱字・推敲にも同時に効く
  "該当なし",
  "そのまま",
  "-",
  "ー",
  "―",
  "‐",
  "--",
];

/** 推敲でだけ足すもの。**一文まるごとがこれに化けることはない** */
const WHOLE_REPLACEMENT_PLACEHOLDERS = ["なし", "無し", "不要", "省略"];

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    // 前後の括弧・引用符を落とす。「（空文字）」の形で返ることがある
    .replace(/^[「『"'“”‘’（(\[【\s]+|[」』"'“”‘’）)\]】。、\s]+$/gu, "");
}

/**
 * この文字列は、AIが「中身が無い」と言うために書いたものか。
 *
 * @param wholeReplacement 置き換える範囲が一文まるごとか（推敲は true）。
 *   true のときだけ「なし」なども中身無しとして扱う
 */
export function isPlaceholderText(
  text: string,
  wholeReplacement = false
): boolean {
  const body = normalize(text);
  if (!body) return false;
  if (PLACEHOLDERS.includes(body)) return true;
  return wholeReplacement && WHOLE_REPLACEMENT_PLACEHOLDERS.includes(body);
}
