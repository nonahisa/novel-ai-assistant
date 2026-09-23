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

/**
 * **前後の本文で候補を絞る**（設計書6.96.3）。指摘を数日残すために
 * 足した。`hintLine` は検知した日の行番号なので、三日ぶん書き足された
 * あとでは手がかりとして弱い——「近いほう」で選ぶと、**遠くの正しい
 * 一致より、近くの別の一致**を採ってしまう。
 */
describe("relocateQuote（前後の文脈つき）", () => {
  const twice = [
    "　夜の教室は静かだった。", // 1
    "　彼女は振り返らなかった。", // 2
    "　鍵の音が響く。", // 3
    "　朝の廊下は騒がしかった。", // 4
    "　彼女は振り返らなかった。", // 5
    "　誰も呼び止めなかった。", // 6
  ].join("\n");
  const quote = "　彼女は振り返らなかった。";

  test("文脈が合うほうを採る（近さでは別のほうが勝つ場面でも）", () => {
    expect(
      relocateQuote(twice, quote, 5, {
        before: "　夜の教室は静かだった。",
        after: "　鍵の音が響く。",
      })
    ).toBe(2);
  });

  test("片方しか合わなくても、合う数の多いほうを採る", () => {
    expect(
      relocateQuote(twice, quote, 2, { after: "　誰も呼び止めなかった。" })
    ).toBe(5);
  });

  /** 文脈のほうが古びていることもある。絞れなければ、近さで決める */
  test("どの候補も文脈に合わなければ、絞らない", () => {
    expect(
      relocateQuote(twice, quote, 5, { before: "もう無い行", after: "これも無い" })
    ).toBe(5);
  });

  /** 渡さなければ、これまでどおり（既存の呼び出し側の動きを変えない） */
  test("文脈を渡さなければ、近さだけで決まる", () => {
    expect(relocateQuote(twice, quote, 5)).toBe(5);
    expect(relocateQuote(twice, quote, 5, {})).toBe(5);
  });

  test("空行を挟んでいても、中身のある隣の行と比べる", () => {
    const spaced = [
      "　夜の教室は静かだった。", // 1
      "",
      "　彼女は振り返らなかった。", // 3
      "",
      "　朝の廊下は騒がしかった。", // 5
      "",
      "　彼女は振り返らなかった。", // 7
    ].join("\n");

    expect(
      relocateQuote(spaced, quote, 7, { before: "　夜の教室は静かだった。" })
    ).toBe(3);
  });

  /** 「。」のような短い断片はどこにでも含まれる。絞ったつもりで絞れない */
  test("短すぎる文脈では絞らない", () => {
    expect(relocateQuote(twice, quote, 5, { before: "。" })).toBe(5);
  });
});
