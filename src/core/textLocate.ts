/**
 * 本文の中から「AIが言っている箇所」を見つける。
 *
 * **AIが引用した文字列が本当に本文にあるかを、必ず照合する。**
 * この作品で繰り返し立てている原則（AIの出力を信用しない）そのもので、
 * 誤字脱字検知でも同じ照合をしている。照合せずに位置だけ信じると、
 * AIが少し言い換えた引用に対して**別の場所を光らせる**ことになり、
 * 作者は「そこは何も問題ないが」と混乱する。
 *
 * 見つからなければ位置を返さない。**当てずっぽうで近い場所を光らせない。**
 *
 * VS Code APIに依存しない。
 */

export interface TextRange {
  /** 0始まりの行番号 */
  line: number;
  /** 行内の0始まりの文字位置 */
  character: number;
  endLine: number;
  endCharacter: number;
}

/**
 * 引用文の位置を求める。
 *
 * 改行コードは行番号の数え方に影響するため、`\r\n` を1文字として
 * 扱わないよう先に潰してから数える。呼び出し側（エディター）も
 * 行と桁で位置を指すので、これで噛み合う。
 */
export function findTextRange(
  content: string,
  needle: string
): TextRange | undefined {
  const text = content.replace(/\r\n?/g, "\n");
  const target = needle.replace(/\r\n?/g, "\n");

  const index = locate(text, target);
  if (index === undefined) return undefined;

  const start = toPosition(text, index.at);
  const end = toPosition(text, index.at + index.length);
  return {
    line: start.line,
    character: start.character,
    endLine: end.line,
    endCharacter: end.character,
  };
}

/**
 * 引用の探し方は2段階。
 *
 * 1. そのまま探す
 * 2. 前後の空白を落として探す
 *
 * **空白を潰した「だいたい一致」までは踏み込まない。** 一致の幅を広げるほど
 * 別の箇所に当たる危険が増える。見つからないと正直に言うほうが、
 * 違う場所を光らせるより作者の役に立つ。
 */
function locate(
  text: string,
  needle: string
): { at: number; length: number } | undefined {
  if (!needle) return undefined;

  const direct = text.indexOf(needle);
  if (direct !== -1) return { at: direct, length: needle.length };

  const trimmed = needle.trim();
  if (trimmed && trimmed !== needle) {
    const at = text.indexOf(trimmed);
    if (at !== -1) return { at, length: trimmed.length };
  }

  return undefined;
}

function toPosition(
  text: string,
  offset: number
): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;

  for (let index = 0; index < offset; index++) {
    if (text[index] === "\n") {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, character: offset - lineStart };
}
