import { describe, expect, test } from "vitest";
import {
  CHAT_EXAMPLES,
  READER_TARGET_EXAMPLE,
  chatExamplesFor,
} from "../../src/core/chatExamples";
import { selectProcedure } from "../../src/core/procedures";

/**
 * 相談パネルの「聞き方の例」（作者の要望、2026-09-22）。
 *
 * **押した瞬間に「画面で案内してもらう」が出る言い方だけを置く。**
 * 当たりの判定は漢字2文字の組みなので、「次の話のプロットを考えたい」や
 * 「ターゲットシートを見せて」のように**漢字2字の組みを持たない言い方は
 * 当たらない**。ここが見張っていないと、押しても案内が出ない札が並ぶ。
 */

const ALL = [...CHAT_EXAMPLES, READER_TARGET_EXAMPLE];

describe("例はどれも手順書きに当たる", () => {
  for (const example of ALL) {
    test(`「${example}」は手順書きを引き当てる`, () => {
      expect(selectProcedure({ question: example })).toBeDefined();
    });
  }

  test("読者の例は、読者の手順書きへ当たる", () => {
    // 読者の話が校正や投稿の手順へ吸われていたら、案内は出ても中身が違う
    expect(selectProcedure({ question: CHAT_EXAMPLES[0] })?.key).toBe(
      "readerTarget"
    );
    expect(selectProcedure({ question: READER_TARGET_EXAMPLE })?.key).toBe(
      "readerTarget"
    );
  });

  test("漢字2字の組みを含む言い方になっている", () => {
    // 当たりの根拠そのもの。ここが無い言い方は、手順書きにも束にも当たらない
    for (const example of ALL) {
      expect(/\p{Script=Han}{2}/u.test(example), example).toBe(true);
    }
  });
});

describe("並べる数", () => {
  test("3〜5つに留める（入力欄の上に置くので、増やすほど会話が押される）", () => {
    expect(chatExamplesFor({ readerTargetDiagnosed: true }).length).
      toBeGreaterThanOrEqual(3);
    expect(chatExamplesFor({ readerTargetDiagnosed: false }).length).
      toBeLessThanOrEqual(5);
  });

  test("読者像が未診断のときだけ「読者型を決めたい」を足す", () => {
    expect(chatExamplesFor({ readerTargetDiagnosed: false })).toContain(
      READER_TARGET_EXAMPLE
    );
    // 決めたあとに出し続けると、済んだ仕事を勧めることになる
    expect(chatExamplesFor({ readerTargetDiagnosed: true })).not.toContain(
      READER_TARGET_EXAMPLE
    );
  });

  test("同じ言い方を2つ置かない", () => {
    expect(new Set(ALL).size).toBe(ALL.length);
  });
});
