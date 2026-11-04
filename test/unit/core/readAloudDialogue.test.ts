import { describe, expect, test } from "vitest";
import { buildReadingPlan, voiceDialogueSpans } from "../../../src/core/readAloud";

/**
 * 人物の声で朗読する——文の計画に「地の文／台詞」を持たせる（設計書6.42.3）。
 *
 * これまでの性質（記法の内側で切らない・200字で切る・位置は元の本文）を
 * 壊さないことも、台詞の境目で切ったときに確かめる。
 */

function pieces(text: string, split = true): Array<[string, string, number | undefined]> {
  return buildReadingPlan(text, "curly", [], { splitDialogue: split }).map((s) => [
    text.slice(s.start, s.end),
    s.kind,
    s.dialogue,
  ]);
}

describe("台詞と地の文を分ける", () => {
  test("「…」と彼は言った。は、台詞と地の文の2つに分かれる", () => {
    expect(pieces("「行こう」と彼は言った。")).toEqual([
      ["「行こう」", "dialogue", 0],
      ["と彼は言った。", "narration", undefined],
    ]);
  });

  test("行頭の台詞のあとの地の文は、台詞と地の文の2つ。台詞の後ろの地の文の中の括弧は地の文のまま", () => {
    expect(pieces("「待て」と彼は叫び、「逃げろ」と続けた。")).toEqual([
      ["「待て」", "dialogue", 0],
      ["と彼は叫び、「逃げろ」と続けた。", "narration", undefined],
    ]);
  });

  test("閉じ括弧のすぐ後ろの句読点は台詞の側（句点だけの文を作らない）", () => {
    expect(pieces("「はい」。彼は頷いた。")).toEqual([
      ["「はい」。", "dialogue", 0],
      ["彼は頷いた。", "narration", undefined],
    ]);
  });

  test("台詞の番号は話の頭から数える。台詞の中の句点で割れた後ろも同じ番号", () => {
    const plan = buildReadingPlan("「一つ。二つ」\n地の文。\n「三つ」", "curly", [], {
      splitDialogue: true,
    });
    expect(plan.map((s) => [s.speech, s.kind, s.dialogue])).toEqual([
      ["「一つ。", "dialogue", 0],
      ["二つ」", "dialogue", 0],
      ["地の文。", "narration", undefined],
      ["「三つ」", "dialogue", 1],
    ]);
  });

  test("切らない既定（OSの声）でも、種別は付く。文の分け方はこれまでどおり", () => {
    expect(pieces("「行こう」と彼は言った。", false)).toEqual([
      ["「行こう」と彼は言った。", "dialogue", 0],
    ]);
    expect(pieces("彼は「待て」と叫んだ。", false)).toEqual([
      ["彼は「待て」と叫んだ。", "narration", undefined],
    ]);
  });

  test("記法の内側では切らない（ルビの親文字の中の括弧）", () => {
    const text = "{「嘘」|うそ}だと彼は言った。";
    const plan = buildReadingPlan(text, "curly", [], { splitDialogue: true });
    // 記法は1つの文の中に丸ごと残る
    expect(plan.map((s) => text.slice(s.start, s.end)).join("")).toBe(text);
    for (const s of plan) {
      const slice = text.slice(s.start, s.end);
      if (slice.includes("{")) expect(slice).toContain("|うそ}");
    }
  });

  test("位置は元の本文のもの（字下げを落として、text.slice が原文）", () => {
    const text = "　「おはよう」と{灯|あかり}は言った。";
    const plan = buildReadingPlan(text, "curly", [], { splitDialogue: true });
    expect(plan.map((s) => text.slice(s.start, s.end))).toEqual([
      "「おはよう」",
      "と{灯|あかり}は言った。",
    ]);
    expect(plan[1].speech).toBe("とあかりは言った。");
  });

  test("辞書の読みの差し替えは、切ったあとも効く", () => {
    const text = "「十分待った」と言った。";
    const at = text.indexOf("十分");
    const plan = buildReadingPlan(
      text,
      "curly",
      [{ start: at, end: at + 2, reading: "じっぷん" }],
      { splitDialogue: true }
    );
    expect(plan.map((s) => s.speech)).toEqual(["「じっぷん待った」", "と言った。"]);
  });

  test("200字を超える台詞は、これまでどおり読点で切る（番号は同じ）", () => {
    const long = "「" + "あ".repeat(199) + "、" + "い".repeat(30) + "」と言った。";
    const plan = buildReadingPlan(long, "curly", [], { splitDialogue: true });
    expect(plan.map((s) => [s.kind, s.dialogue])).toEqual([
      ["dialogue", 0],
      ["dialogue", 0],
      ["narration", undefined],
    ]);
  });
});

describe("台詞と見る範囲", () => {
  test("地の文の『』（書名・呼び名）は台詞にしない。行頭の『』は台詞", () => {
    const text = "彼らは『死の谷』へ向かった。\n『聞こえるか』";
    const spans = voiceDialogueSpans(text).map((s) => text.slice(s.start, s.end));
    expect(spans).toEqual(["『聞こえるか』"]);
  });

  test("シーンメモの行の括弧は数えない", () => {
    const text = "// 「ここ」を直す\n「本文の台詞」";
    expect(voiceDialogueSpans(text).map((s) => text.slice(s.start, s.end))).toEqual([
      "「本文の台詞」",
    ]);
  });

  test("最後まで閉じない台詞は台詞と見ない（残り全部を台詞の声にしない）", () => {
    expect(voiceDialogueSpans("「閉じないまま、話が終わる。")).toEqual([]);
  });
});

describe("括弧を重ねた台詞を1つに畳む（偽の台詞を作らない）", () => {
  function quotes(text: string): string[] {
    return voiceDialogueSpans(text).map((s) => text.slice(s.start, s.end));
  }

  test("「「はぁい」」は1つの台詞", () => {
    expect(quotes("「「はぁい」」")).toEqual(["「「はぁい」」"]);
  });

  test("「「「いらっしゃいませ」」」」は余った閉じ括弧まで1つの台詞", () => {
    expect(quotes("「「「いらっしゃいませ」」」」")).toEqual(["「「「いらっしゃいませ」」」」"]);
  });

  test("重ねた台詞のあとの台詞は別の台詞のまま", () => {
    expect(quotes("「「「やっぱりそうなんのか。」」」」「あれから…」")).toEqual([
      "「「「やっぱりそうなんのか。」」」」",
      "「あれから…」",
    ]);
  });

  test("ふつうの「はい」と行頭の『心の声』は今までどおり", () => {
    expect(quotes("「はい」と彼は言った。\n『心の声』")).toEqual(["「はい」", "『心の声』"]);
  });

  test("計画に、括弧1字だけの文を作らない", () => {
    const a = "「「「いらっしゃいませ」」」」";
    expect(pieces(a)).toEqual([[a, "dialogue", 0]]);
    const b = "「「はぁい」」";
    expect(pieces(b)).toEqual([[b, "dialogue", 0]]);
  });

  test("括弧だけの文は人物の声の計画から除く（OS の声の計画は変えない）", () => {
    const text = "彼は笑った。\n」";
    const split = buildReadingPlan(text, "curly", [], { splitDialogue: true });
    expect(split.map((s) => s.speech)).toEqual(["彼は笑った。"]);
    const os = buildReadingPlan(text, "curly", []);
    expect(os.map((s) => s.speech)).toEqual(["彼は笑った。", "」"]);
  });
});

describe("行頭から始まる括弧だけを台詞にする（地の文の語の括弧は台詞にしない）", () => {
  function quotes(text: string): string[] {
    return voiceDialogueSpans(text).map((s) => text.slice(s.start, s.end));
  }

  test("地の文の途中で語に付けた「」は台詞にしない", () => {
    const text = "空気を指す「風」は「熱」と「湿」という二つを運ぶ。";
    expect(quotes(text)).toEqual([]);
    expect(pieces(text)).toEqual([[text, "narration", undefined]]);
  });

  test("行頭の「はい」と、字下げ（全角・半角）のあとの「はい」は台詞", () => {
    expect(quotes("「はい」")).toEqual(["「はい」"]);
    expect(quotes("　「はい」")).toEqual(["「はい」"]);
    expect(quotes(" 「はい」")).toEqual(["「はい」"]);
  });

  test("閉じたあと空白だけで続く台詞（2つ目）も台詞。台詞2つ", () => {
    expect(quotes("「はい」「いいえ」")).toEqual(["「はい」", "「いいえ」"]);
    expect(quotes("「はい」　「いいえ」")).toEqual(["「はい」", "「いいえ」"]);
  });

  test("地の文をはさんだあとの括弧は、同じ行でも台詞にしない", () => {
    expect(quotes("「はい」と彼は言い、「いいえ」と続けた。")).toEqual(["「はい」"]);
  });

  test("彼は「行こう」と言った。は地の文1つ", () => {
    const text = "彼は「行こう」と言った。";
    expect(quotes(text)).toEqual([]);
    expect(pieces(text)).toEqual([[text, "narration", undefined]]);
  });

  test("行頭の『心の声』は台詞。連なりは行ごとに数え直す", () => {
    expect(quotes("『心の声』")).toEqual(["『心の声』"]);
    expect(quotes("前の行は「地の文」\n「次の行の台詞」")).toEqual(["「次の行の台詞」"]);
  });

  test("OS の声の計画（splitDialogue なし）は、これまでどおり1文のまま", () => {
    const text = "空気を指す「風」は吹く。";
    expect(buildReadingPlan(text, "curly", []).map((s) => s.speech)).toEqual([text]);
  });
});
