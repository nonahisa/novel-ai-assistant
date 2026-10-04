import { describe, expect, test } from "vitest";
import { parseFindingAdvice } from "../../../src/core/findingAdviceValidation";

/**
 * 推敲の指摘への短い助言（P-47）の検証。**AIの出力を信用しない**（規則3）。
 *
 * 作者の報告（2026-10-05）「AIに相談がくどすぎます」「選択肢の意味も
 * わかりません」。長い答え・案の名前だけの選択肢・前後の段落の写しを
 * 画面に出さない。
 */

const QUOTE = "　彼女は外を見ている彼女を見ていた。";
const BEFORE = "　窓の外は雪だった。冬の街は静かで、遠くで鐘が鳴っていた。";
const AFTER = "　鐘が鳴った。";
const material = { quote: QUOTE, before: BEFORE, after: AFTER };

function parse(value: unknown) {
  return parseFindingAdvice(JSON.stringify(value), material);
}

describe("読める答え", () => {
  test("引っかかり1文と、一文の中の部分の言い換えを受け取る", () => {
    const advice = parse({
      point: "同じ「彼女」が2度出て、誰が誰を見ているか迷います。",
      examples: [
        { from: "見ている彼女を", to: "窓辺の自分を" },
        { from: "外を見ている彼女を見ていた", to: "外を眺める自分に気づいた" },
      ],
    });
    expect(advice?.point).toBe("同じ「彼女」が2度出て、誰が誰を見ているか迷います。");
    expect(advice?.examples).toEqual([
      { from: "見ている彼女を", to: "窓辺の自分を" },
      { from: "外を見ている彼女を見ていた", to: "外を眺める自分に気づいた" },
    ]);
    expect(advice?.noNeed).toBe(false);
    expect(advice?.dropped).toBe(0);
  });

  /**
   * 手元の Ollama（gemma4:e4b、2026-10-05）で、頭の鉤括弧だけが落ちて
   * 「警戒している」の繰り返しが…」になった。囲み全体のときだけ外す
   */
  test("鉤括弧で始まる引っかかりの、頭の括弧を落とさない", () => {
    const advice = parse({
      point: "「警戒している」の繰り返しが目立ちます。",
      examples: [{ from: "「見ている彼女を」", to: "「窓辺の自分を」" }],
    });
    expect(advice?.point).toBe("「警戒している」の繰り返しが目立ちます。");
    // 全体を囲んだものは外す
    expect(advice?.examples).toEqual([{ from: "見ている彼女を", to: "窓辺の自分を" }]);
  });

  test("コードフェンスや前置きが付いていても読む", () => {
    const text =
      "答えです。\n```json\n" +
      JSON.stringify({ point: "主語が重なっています。", examples: [] }) +
      "\n```";
    expect(parseFindingAdvice(text, material)?.point).toBe("主語が重なっています。");
  });

  test("「直す必要は薄い」は言い換えを出さない（来ても捨てる）", () => {
    const advice = parse({
      point: "直す必要は薄い——前の段落で視点が移っているため自然に読めます。",
      examples: [{ from: "見ている彼女を", to: "窓辺の自分を" }],
    });
    expect(advice?.noNeed).toBe(true);
    expect(advice?.examples).toEqual([]);
    expect(advice?.dropped).toBe(1);
  });
});

describe("字数", () => {
  test("引っかかりが60字を超えたら、上限の中の句点で切る", () => {
    const point =
      "同じ「彼女」が2度出てくるため、読者は誰が誰を見ているのかを一瞬迷います。" +
      "視点の人物を名前で示すか、自分に言い換えると読みやすくなります。";
    const advice = parse({ point, examples: [] });
    expect([...(advice?.point ?? "")].length).toBeLessThanOrEqual(60);
    expect(advice?.point.endsWith("。")).toBe(true);
  });

  test("句点が無く60字を超えたら、上限の手前で切って「…」を付ける", () => {
    const point = "あ".repeat(80);
    const advice = parse({ point, examples: [] });
    expect([...(advice?.point ?? "")].length).toBe(60);
    expect(advice?.point.endsWith("…")).toBe(true);
  });

  test("言い換えが40字を超えたら、切らずに捨てる（切った言い換えは文として壊れている）", () => {
    const advice = parse({
      point: "主語が重なっています。",
      examples: [{ from: "見ている彼女を", to: "い".repeat(41) }],
    });
    expect(advice?.examples).toEqual([]);
    expect(advice?.dropped).toBe(1);
  });

  test("言い換えは2つまで", () => {
    const advice = parse({
      point: "主語が重なっています。",
      examples: [
        { from: "見ている彼女を", to: "窓辺の自分を" },
        { from: "見ていた", to: "見つめていた" },
        { from: "外を", to: "表を" },
      ],
    });
    expect(advice?.examples).toHaveLength(2);
    expect(advice?.dropped).toBe(1);
  });
});

describe("捨てるもの", () => {
  test("本文の一文に無い部分の言い換えは捨てる（どこを言い換えたのか確かめられない）", () => {
    const advice = parse({
      point: "主語が重なっています。",
      examples: [{ from: "空を見上げた", to: "空を仰いだ" }],
    });
    expect(advice?.examples).toEqual([]);
  });

  test("言い換えになっていない（同じ）ものは捨てる", () => {
    const advice = parse({
      point: "主語が重なっています。",
      examples: [{ from: "見ていた", to: "見ていた" }],
    });
    expect(advice?.examples).toEqual([]);
  });

  test.each([
    "Aの方向",
    "案1",
    "方向性B",
    "B案",
    "もっと内面に寄せる方向で",
  ])("案の名前だけの「%s」は捨てる", (to) => {
    const advice = parse({
      point: "主語が重なっています。",
      examples: [{ from: "見ている彼女を", to }],
    });
    expect(advice?.examples).toEqual([]);
  });

  test("前後の段落の写しは捨てる（答えに引用させない）", () => {
    const advice = parse({
      point: "窓の外は雪だった。冬の街は静かで",
      examples: [{ from: "見ていた", to: "冬の街は静かで、遠くで鐘が" }],
    });
    // 引っかかりも言い換えも残らない → 読めない扱い
    expect(advice).toBeUndefined();
  });

  /** CLAUDE.md「繰り返し起きた失敗3」：指示の言葉が中身として返る */
  test.each([
    "何が引っかかっているか",
    "言い換え例",
    "60字以内",
    "何が引っかかっているかを、60字以内の1文で書いてください。",
    "特になし",
  ])("指示の言葉・埋め草「%s」は引っかかりとして出さない", (point) => {
    const advice = parse({
      point,
      examples: [{ from: "見ている彼女を", to: "窓辺の自分を" }],
    });
    expect(advice?.point).toBe("");
    // 言い換えが残れば、それだけは出す
    expect(advice?.examples).toHaveLength(1);
  });

  test.each(["その部分の言い換え", "言い換え", "40字以内"])(
    "指示の言葉「%s」は言い換えとして出さない",
    (to) => {
      const advice = parse({
        point: "主語が重なっています。",
        examples: [{ from: "見ている彼女を", to }],
      });
      expect(advice?.examples).toEqual([]);
    }
  );

  test("空の答え・形の違う答えは読めない扱い", () => {
    expect(parse({ point: "", examples: [] })).toBeUndefined();
    expect(parseFindingAdvice("読めません", material)).toBeUndefined();
    expect(parseFindingAdvice("[1,2]", material)).toBeUndefined();
  });

  test("短い語（「彼女は」）は前後の段落にも出うるので、写しとしては扱わない", () => {
    const advice = parse({
      point: "主語が重なっています。",
      examples: [{ from: "見ている彼女を", to: "鐘が鳴った" }],
    });
    // 「鐘が鳴った」（5字）は後ろの段落と同じだが短いので落とさない
    expect(advice?.examples).toHaveLength(1);
  });
});
