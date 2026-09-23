/**
 * 途中で終わったAIの応答を扱う部品（設計書6.77の第2段の続き。残課題8）。
 *
 * VS Code に依存しない。プロバイダ（`ai/`）・プロンプト（`prompts/`）・
 * 機能（`features/`）のどこからでも使えるよう、`core` に置く。
 *
 * ## 空白だけの行で埋まる
 *
 * 2026-09-22、さくらのAI `preview/gemma-4-31B-it` のプロット逸脱検知で、
 * 第11話の応答が「該当なし」を表す要素を1件書いたあと、**空白だけの行を
 * 出力上限（12,288トークン）まで書き続けて**切り詰められた。2026-09-19 の
 * 作品紹介文（`preview/Qwen3.6-35B-A3B`）も `"confidence":` のあと空白で
 * 切られていた——**モデルをまたいで同じ型**が出ている。
 *
 * これは**上限が足りなかったのではない。** 上限を上げれば、空白が
 * もっと長く続くだけである。だから「出力上限で切り詰められました」とは
 * 分けて扱う：記録の文言を分け、上限の学習（`ai/meteredProvider.ts`）に
 * 数えず、流して受け取る道（Ollama）では途中で打ち切る。
 */

/**
 * 「空白で埋まった」と見なす、末尾の空白の連続の長さ（字数）。
 *
 * **2,000字にした理由**：字下げ付きで整形したJSONは行ごとに空白を持つが、
 * 1行の字下げは深くても数十字で、**連続はしない**（間に中身が挟まる）。
 * 末尾に改行が数個付くのも、ふつうのことである。本文の引用に全角空白が
 * 並ぶことはあっても、2,000字続くことはない。
 *
 * 一方で、実機の空白は万の単位で続いていた。2,000字は数秒で書かれる量
 * なので、流して受け取る道ではここで打ち切れば待ち時間のほとんどを省ける。
 * 低くしすぎると、まっとうな応答を失敗扱いにする（そちらのほうが害が大きい）。
 */
export const WHITESPACE_RUNAWAY_CHARS = 2_000;

/** 1字が空白か（半角・全角・改行・タブ） */
const WHITESPACE = /\s/u;

/**
 * 末尾に続く空白（半角・全角・改行・タブ）の字数。
 *
 * @param limit ここまで数えたら止める。流して受け取る道は断片が届くたびに
 *   数えるので、空白が万の単位で続いても毎回しきい値ぶんしか見ない
 */
export function trailingWhitespaceLength(
  text: string,
  limit = Number.POSITIVE_INFINITY
): number {
  let count = 0;
  for (let i = text.length - 1; i >= 0 && count < limit; i--) {
    if (!WHITESPACE.test(text[i])) break;
    count += 1;
  }
  return count;
}

/** 応答の末尾が空白で埋まっているか（しきい値は上の定数） */
export function endsInWhitespaceRunaway(text: string): boolean {
  // 先に長さで見る。しきい値より短い応答は、数えるまでもなく該当しない
  if (text.length < WHITESPACE_RUNAWAY_CHARS) return false;
  return (
    trailingWhitespaceLength(text, WHITESPACE_RUNAWAY_CHARS) >=
    WHITESPACE_RUNAWAY_CHARS
  );
}

/**
 * 読めなかった応答について、記録（操作ログ）に残す理由。
 *
 * - 空白で埋まった……上限の不足ではないと分かる文言にする。「上限を
 *   大きくすれば直る」と読めると、作者も開発側も直らない操作を繰り返す
 * - 空白ではない切り詰め……これまでどおりの文言（各機能と同じ）
 * - どちらでもない……`undefined`（呼ぶ側が「読み取れません」などを選ぶ）
 *
 * **切り詰めの印が無くても、空白で埋まっていれば空白と書く。** 流して
 * 受け取る道は、空白が続いた時点でこちらから打ち切るので、上限に届かない。
 */
export function truncationReasonForLog(response: {
  text: string;
  truncated: boolean;
}): string | undefined {
  if (endsInWhitespaceRunaway(response.text)) {
    return (
      "応答が空白だけの行で埋まりました（中身を書き終えたあと、空白を" +
      "書き続けていました。出力上限を大きくしても直りません）"
    );
  }
  if (response.truncated) return "応答が出力上限で切り詰められました";
  return undefined;
}

/**
 * 空白で埋まって読めなかったときに、作者へ出す次の一手。
 *
 * **上限の話をしない。** 切り詰めの案内（`ai/outputLimit.ts` の
 * `truncatedOutputAdvice`）は「質問を短く」「上限を大きく」と言うが、
 * 空白で埋まったのは上限の不足ではないので、どちらも直らない。
 * モデルのその回の崩れなので、もう一度か、別のモデルを勧める。
 */
export const WHITESPACE_RUNAWAY_ADVICE =
  "AIの応答が、書き終えたあと空白だけの行で埋まってしまい、読み取れませんでした。" +
  "出力の上限を大きくしても直りません。もう一度実行するか、別のモデルでお試しください。";

/** 「ここまでなら値が完結している」位置と、そのときに開いていた括弧 */
interface SafePoint {
  end: number;
  stack: string[];
}

/**
 * 途中で切れたJSONを、閉じて読める形にした候補を作る（新しい順に2つまで）。
 *
 * **もとは相談（`prompts/workChat.ts`）の中にあった**（作者の実機報告、
 * 2026-09-23）。プロット逸脱検知の「空白で埋まった応答」でも同じことが
 * 要るので、ここへ移した（中身は変えていない）。
 *
 * **候補を2つ返すのは、切れ方が2通りあるからである。**
 * ①いまの位置のまま閉じる……切れた文字列の中身まで残る。**途中で切れた
 * `reply` こそ作者が読みたいもの**なので、こちらを先に試す。
 * ②値が完結しているところまで切り戻して閉じる……数値や `true` の途中で
 * 切れていて①が読めないときの受け皿。
 *
 * 救えないと分かったら**空を返す**（呼ぶ側は生の本文の扱いへ落ちる）。
 * ここで無理に形を作ると、中身の違うJSONを「読めた」ことにしてしまう。
 */
export function closeTruncatedJson(text: string): string[] {
  const start = text.indexOf("{");
  if (start === -1) return [];
  let body = text.slice(start);
  // 後ろにコードフェンスが残っていたら落とす（前は `{` から取っている）
  const fence = body.indexOf("```");
  if (fence !== -1) body = body.slice(0, fence);

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let safe: SafePoint | undefined;
  /** いま読んでいる文字列が始まる直前の安全点（鍵だったときに戻す先） */
  let beforeString: SafePoint | undefined;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        safe = { end: i + 1, stack: [...stack] };
      }
      continue;
    }
    if (ch === '"') {
      beforeString = safe;
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      // 閉じすぎている＝そもそも形が読めない。作り直さない
      if (stack.length === 0) return [];
      stack.pop();
      safe = { end: i + 1, stack: [...stack] };
      continue;
    }
    // 鍵の直後のコロン。**直前の文字列は値ではなく鍵だった**ので、安全点を
    // その文字列の前まで戻す（`{"reply"` で切り戻しても読めない）
    if (ch === ":") safe = beforeString;
  }

  // 閉じているなら、上の3通りで読めなかった理由はここには無い
  if (stack.length === 0 && !inString) return [];

  const candidates: string[] = [];
  const head = inString
    ? `${dropDanglingEscape(body)}"`
    : // 末尾の中途半端な区切り（`,` や空白）は落としてから閉じる
      body.replace(/[\s,]+$/, "");
  candidates.push(head + closingFor(stack));
  if (safe && safe.end > 0) {
    candidates.push(body.slice(0, safe.end) + closingFor(safe.stack));
  }
  return candidates;
}

/** 開いたままの括弧を、逆順に閉じる文字列 */
function closingFor(stack: string[]): string {
  return [...stack]
    .reverse()
    .map((open) => (open === "{" ? "}" : "]"))
    .join("");
}

/**
 * 文字列がエスケープの途中で切れていたら、その頭を落とす。
 *
 * 落とさずに `"` を足すと `"…\"` となって**閉じたことにならない**。
 */
function dropDanglingEscape(text: string): string {
  // 末尾の連続した逆斜線を数える。奇数なら最後の1本がエスケープの頭
  let slashes = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  if (slashes % 2 === 1) return text.slice(0, -1);
  // `\u00` のようにUnicodeエスケープの途中で切れた形
  const unicode = text.match(/\\u[0-9a-fA-F]{0,3}$/);
  if (unicode) {
    const at = text.length - unicode[0].length;
    // その逆斜線自身がエスケープされているなら（`\\u12`）、ただの文字
    let back = 0;
    for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) back++;
    if (back % 2 === 0) return text.slice(0, at);
  }
  return text;
}
