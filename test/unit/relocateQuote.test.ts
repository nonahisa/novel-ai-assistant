import { describe, expect, test } from "vitest";
import { relocateQuote } from "../../src/core/relocateQuote";

/**
 * 引用が「いま何行目に在るか」を探し直す（作者の報告、2026-09-12）。
 *
 * 指摘が持っている行番号は検知したときのもので、1件当てた瞬間に古くなる。
 * 飛び先を決めるのは行番号ではなく**引用のほう**、という考え方を確かめる。
 */

/** 3行目に引用が在る本文 */
const text = [
  "　朝の廊下は静かだった。",
  "",
  "　彼女は振り返らなかった。",
  "",
  "　窓の外で鐘が鳴る。",
].join("\n");

describe("relocateQuote", () => {
  test("行が増えたあとでも、引用の在る行を返す", () => {
    // 検知したときは3行目。前に2行足されて、いまは5行目にある
    const grown = ["追加1", "追加2", ...text.split("\n")].join("\n");

    expect(relocateQuote(grown, "　彼女は振り返らなかった。", 3)).toBe(5);
  });

  test("行が減ったあとでも、引用の在る行を返す", () => {
    // 前の2行が1行にまとまって、3行目が2行目へ繰り上がった
    const shrunk = ["　朝の廊下は静かだった。", "　彼女は振り返らなかった。"].join(
      "\n"
    );

    expect(relocateQuote(shrunk, "　彼女は振り返らなかった。", 3)).toBe(2);
  });

  test("同じ引用が2か所にあれば、hintLine に近いほうを返す", () => {
    const twice = [
      "　彼女は振り返らなかった。", // 1
      "つなぎ",
      "つなぎ",
      "つなぎ",
      "つなぎ",
      "　彼女は振り返らなかった。", // 6
    ].join("\n");

    expect(relocateQuote(twice, "　彼女は振り返らなかった。", 2)).toBe(1);
    expect(relocateQuote(twice, "　彼女は振り返らなかった。", 5)).toBe(6);
  });

  test("上下に同じだけ離れていれば、前の行を返す（決め方を1つに固める）", () => {
    const twice = ["引用の行", "まんなか", "引用の行"].join("\n");

    expect(relocateQuote(twice, "引用の行", 2)).toBe(1);
  });

  test("見つからなければ undefined", () => {
    expect(relocateQuote(text, "本文のどこにも無い一文", 3)).toBeUndefined();
  });

  test("空の引用には手を出さない", () => {
    // 空文字はどの行にも「在る」ことになってしまう
    expect(relocateQuote(text, "", 3)).toBeUndefined();
    expect(relocateQuote(text, "　\n　", 3)).toBeUndefined();
  });

  test("複数行の引用は、最初の行で探す", () => {
    const multi = "　彼女は振り返らなかった。\n　そのまま歩き出した。";

    // 2行目（「そのまま〜」）は本文に無いが、最初の行で当たる
    expect(relocateQuote(text, multi, 3)).toBe(3);
  });

  test("先頭が空行の引用でも、中身のある行で探す", () => {
    expect(relocateQuote(text, "\n　窓の外で鐘が鳴る。", 4)).toBe(5);
  });

  test("全角空白の揺れがあっても当たる", () => {
    // 比べ方は `normalizeForComparison`（空白とバイト表記を落とす）に任せる
    expect(relocateQuote(text, "彼女は振り返らなかった。", 1)).toBe(3);
    expect(
      relocateQuote(text, "<0xE3><0x80><0x80>彼女は 振り返らなかった。", 1)
    ).toBe(3);
  });

  test("CRLF の本文でも行を数え違えない", () => {
    const crlf = text.replace(/\n/g, "\r\n");

    expect(relocateQuote(crlf, "　窓の外で鐘が鳴る。", 1)).toBe(5);
  });
});
