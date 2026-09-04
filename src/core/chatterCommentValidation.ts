import { isPlaceholderText } from "./placeholderText";

/**
 * 本文を読んで言う一言の検査（設計書6.21.4、P-34）。
 *
 * **AIの出力を信用しない。** 独り言は作者が頼んでいない発言なので、
 * 読めない答えを出すくらいなら黙るのが正しい。ここで捨てたものは
 * どこにも出ない（記録だけ残す）。
 *
 * 捨てるのは3つ。
 *
 * - **長すぎる答え。** 独り言は横から差し込む1行である
 * - **指示語のなぞり。** プロンプトに書いた語（「感想」「一言」）は
 *   そのまま答えとして返ってくる（この作品で繰り返し起きた失敗3の型）
 * - **助言・指摘の形。** 粗探しは誤字脱字・矛盾検知の仕事であり、
 *   書いた直後に言われると興が削がれる（6.21.1の「誤字脱字は最後」と同じ）
 *
 * **切り詰めない。** 60字で切ると文が途中で終わり、独り言として
 * いちばん間の抜けた出方になる。長ければ丸ごと捨てる。
 */

/** 一言の上限。これを超えたら捨てる（縮めない） */
export const CHATTER_COMMENT_MAX_CHARS = 60;

/**
 * 指示語のなぞり。
 *
 * **プロンプトの指示文からも参照する**（`prompts/chatterComment.ts`）。
 * 同じ定数から出すことで、指示を書き換えたのに検査だけ古い、という
 * 食い違いを防ぐ（`nameSuggest.ts` と同じ手）。
 */
export const CHATTER_COMMENT_HINTS = [
  "感想",
  "一言",
  "ひとこと",
  "コメント",
  "応援",
  "励まし",
] as const;

/**
 * 助言・指摘の語。**含まれていたら捨てる。**
 *
 * ここに「気になる」を入れていない。「続きが気になります」は
 * この機能がいちばん言ってほしい応援だからである。
 */
export const CHATTER_COMMENT_ADVICE_WORDS = [
  "誤字",
  "脱字",
  "表記ゆれ",
  "表記の揺れ",
  "矛盾",
  "修正",
  "訂正",
  "推敲",
  "添削",
  "校正",
  "改善",
  "指摘",
  "書き直",
  "手直し",
] as const;

/**
 * 助言の言い回し。語では拾えない形を、並びで見る。
 *
 * 「〜のほうが」は入れていない（「彼のほうが強い」は感想である）。
 * 拾うのは**動作を勧める形**だけにする。
 */
const ADVICE_PATTERNS: readonly RegExp[] = [
  /(すべき|べきです|べきだ|べきでしょう)/u,
  /(し|た)(ほう|方)が/u,
  // 「増やすといいと思います」の形。**「〜といい〜といい」（褒め言葉）を
  // 拾わないよう、後ろに続く言葉まで見る**
  /(と|たら|れば)(いい|良い|よい)(と思|でしょう|かもしれ|ですね|です|。|$)/u,
  /(てみては|てはどう|てみてください|てください)/u,
];

/** 指示語がそのまま返ってきた形（「感想：〜」「（一言）」） */
const HINT_PREFIX = new RegExp(
  `^(${CHATTER_COMMENT_HINTS.join("|")})\\s*(は|を|が|です|：|:)`,
  "u"
);

/**
 * 独り言として出してよい一言か。出せないなら undefined（黙る）。
 *
 * 改行を空白へ畳むのは、独り言が1行で出るためである。
 */
export function validateChatterComment(raw: string): string | undefined {
  const body = raw.replace(/\s+/gu, " ").trim();
  if (!body) return undefined;

  // 「なし」「特になし」のような、中身の無い言葉
  if (isPlaceholderText(body, true)) return undefined;

  // 字数は符号位置で数える（絵文字が混ざっても数え方を変えない）
  if ([...body].length > CHATTER_COMMENT_MAX_CHARS) return undefined;

  if (isHintEcho(body)) return undefined;
  if (isAdvice(body)) return undefined;

  return body;
}

/**
 * 指示語をなぞっただけの答えか。
 *
 * **完全一致と、頭に置いた形だけを見る。** 「最後の一言が効いています」は
 * 本文についての感想であって、指示のなぞりではない。含む・含まないで
 * 判定すると、この機能がいちばん言ってほしい種類の一言を捨ててしまう。
 */
function isHintEcho(body: string): boolean {
  const bare = body
    .replace(/^[「『"'“”‘’（(\[【\s]+/u, "")
    .replace(/[」』"'“”‘’）)\]】。、！？\s]+$/u, "")
    .trim();
  if ((CHATTER_COMMENT_HINTS as readonly string[]).includes(bare)) return true;
  return HINT_PREFIX.test(bare);
}

/** 助言・指摘の形か */
function isAdvice(body: string): boolean {
  if (
    (CHATTER_COMMENT_ADVICE_WORDS as readonly string[]).some((word) =>
      body.includes(word)
    )
  ) {
    return true;
  }
  return ADVICE_PATTERNS.some((pattern) => pattern.test(body));
}
