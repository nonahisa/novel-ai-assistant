import { describe, expect, test } from "vitest";
import { ADVICE_QUESTIONS } from "../../../src/core/advicePolicy";
import { AUTHOR_READER_QUESTIONS } from "../../../src/core/authorReaderType";
import {
  adviceChoiceFromReader,
  orderWithShared,
  readerChoiceFromAdvice,
  sharedAdviceIndex,
  sharedForAdvice,
  sharedForReader,
  sharedFromJustAnsweredAdvice,
  sharedReaderIndex,
} from "../../../src/core/sharedDiagnosisQuestion";

/**
 * 2つの診断にまたがる「似た1問」（作者の裁定、2026-09-23）。
 *
 * 助言の受け方 Z3「同じ題材の他作品を熱心に読みますか」と、読者としての
 * 好み A3「いま好きな題材について、似た作品をどれくらい読んできましたか」。
 * 片方で答えたら、もう片方ではその答えを選んだ状態で出す。
 */
describe("共有する1問の対応", () => {
  test("2つの問いが、それぞれの9問の中に実在する", () => {
    expect(ADVICE_QUESTIONS[sharedAdviceIndex()]?.id).toBe("Z3");
    expect(AUTHOR_READER_QUESTIONS[sharedReaderIndex()]?.id).toBe("A3");
  });

  /**
   * **選択肢の向きが同じであること**を、文面と点で確かめる。
   * どちらも「読んだ量が少ない → 多い」の順に 0・1・2 点。向きが逆に
   * なったら、写し替えで反転させないと逆の答えを写してしまう。
   */
  test("選択肢は、読んだ量の少ない順に 0・1・2 点で並ぶ（両方とも）", () => {
    const advice = ADVICE_QUESTIONS[sharedAdviceIndex()];
    const reader = AUTHOR_READER_QUESTIONS[sharedReaderIndex()];

    expect(advice.choices.map((choice) => choice.label)).toEqual([
      "あまり読まない",
      "ときどき",
      "かなり読む",
    ]);
    expect(reader.choices.map((choice) => choice.label)).toEqual([
      "ほとんど読んでいない。これから知るところ",
      "人並みには読んでいる",
      "かなり読んでいる。定番はひととおり通った",
    ]);
    expect(advice.choices.map((choice) => choice.score)).toEqual([0, 1, 2]);
    expect(reader.choices.map((choice) => choice.score)).toEqual([0, 1, 2]);
  });

  test("写し替えは添字そのまま（0↔0・1↔1・2↔2）で、往復して元に戻る", () => {
    for (const choice of [0, 1, 2]) {
      expect(readerChoiceFromAdvice(choice)).toBe(choice);
      expect(adviceChoiceFromReader(choice)).toBe(choice);
      expect(adviceChoiceFromReader(readerChoiceFromAdvice(choice)!)).toBe(choice);
    }
    // 範囲の外は写さない（黙って別の答えにしない）
    expect(readerChoiceFromAdvice(3)).toBeUndefined();
    expect(adviceChoiceFromReader(-1)).toBeUndefined();
  });
});

describe("どちらの答えを写すか", () => {
  /** 9問ぶんの答え（どれも真ん中）。共有する問いだけ、あとで差し替える */
  const nine = () => [1, 1, 1, 1, 1, 1, 1, 1, 1];
  const withAdvice = (choice: number, updatedAt: string) => {
    const answers = nine();
    answers[sharedAdviceIndex()] = choice;
    return { answers, updatedAt };
  };
  const withReader = (choice: number, updatedAt: string) => {
    const answers = nine();
    answers[sharedReaderIndex()] = choice;
    return { answers, updatedAt };
  };

  test("もう片方にしか答えが無ければ、写す", () => {
    expect(sharedForAdvice(withReader(2, "2026-09-01T00:00:00Z"), undefined)).toEqual({
      index: sharedAdviceIndex(),
      choice: 2,
      from: "読者としての好み",
    });
    expect(sharedForReader(withAdvice(0, "2026-09-01T00:00:00Z"), undefined)).toEqual({
      index: sharedReaderIndex(),
      choice: 0,
      from: "助言の受け方",
    });
  });

  test("もう片方のほうが新しければ、写す", () => {
    const shared = sharedForAdvice(
      withReader(2, "2026-09-20T00:00:00Z"),
      withAdvice(0, "2026-09-01T00:00:00Z")
    );
    expect(shared?.choice).toBe(2);
  });

  /**
   * 自分の側を答え直した直後に、古い答えで上書きした状態を出すと、
   * 作者がいま選んだものが画面で消えて見える。
   */
  test("自分の側のほうが新しければ、写さない", () => {
    expect(
      sharedForAdvice(
        withReader(2, "2026-09-01T00:00:00Z"),
        withAdvice(0, "2026-09-20T00:00:00Z")
      )
    ).toBeUndefined();
    expect(
      sharedForReader(
        withAdvice(2, "2026-09-01T00:00:00Z"),
        withReader(0, "2026-09-20T00:00:00Z")
      )
    ).toBeUndefined();
  });

  test("もう片方がまだ答えていなければ、写さない", () => {
    expect(sharedForAdvice(undefined, undefined)).toBeUndefined();
    expect(sharedForReader({ updatedAt: "2026-09-01T00:00:00Z" }, undefined)).toBeUndefined();
  });

  test("「全部やる」の途中は、いま答えたものをそのまま写す", () => {
    const answers = nine();
    answers[sharedAdviceIndex()] = 1;
    expect(sharedFromJustAnsweredAdvice(answers)).toEqual({
      index: sharedReaderIndex(),
      choice: 1,
      from: "助言の受け方",
    });
  });
});

describe("選んだ状態で出す（並べ替え）", () => {
  test("写した答えを先頭へ移し、ほかの並びは変えない", () => {
    expect(orderWithShared(3, 2)).toEqual([2, 0, 1]);
    expect(orderWithShared(3, 1)).toEqual([1, 0, 2]);
    expect(orderWithShared(3, 0)).toEqual([0, 1, 2]);
  });

  test("写すものが無ければ、元の並びのまま", () => {
    expect(orderWithShared(3, undefined)).toEqual([0, 1, 2]);
    expect(orderWithShared(3, 5)).toEqual([0, 1, 2]);
  });
});
