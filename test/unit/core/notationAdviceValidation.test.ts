import { describe, expect, test } from "vitest";
import { parseNotationAdvice } from "../../../src/core/notationAdviceValidation";
import {
  isWidthNotationGroup,
  NOTATION_ADVICE_FULL,
  NOTATION_ADVICE_HALF,
  NOTATION_ADVICE_HINTS,
  NOTATION_ADVICE_NO_UNIFY,
  notationAdviceChoices,
  type NotationAdviceGroup,
} from "../../../src/prompts/notationAdvice";

/**
 * 表記ゆれのAI問い合わせ（P-33、設計書6.73）の応答の検証。
 *
 * **AIの出力を信用しない。** ここで見るのは2つ。
 *
 *   1. `choice` が**渡した表記のどれか**、または「揃えない」か。
 *      選択肢に無い表記・言い換え・新しい表記は捨てる（答えとして扱わない）
 *   2. `reason` に**指示の言葉がそのまま返っていないか**。
 *      「理由」「短く」がそのまま返るのは、この作品で繰り返し起きた形である
 *      （CLAUDE.md の「繰り返し起きた失敗3」）
 *
 * 捨てたときは undefined を返し、呼び出し側は「答えを読み取れなかった」
 * として扱う。**勝手にどちらかへ倒さない**——揃える先を取り違えると、
 * 作者は本文全体を間違ったほうへ直すことになる。
 */

const SURFACES = ["引っ越し", "引越し"];

function parse(json: string) {
  return parseNotationAdvice(json, SURFACES);
}

describe("choice の照合", () => {
  test("渡した表記なら通す", () => {
    const advice = parse('{"choice":"引っ越し","reason":"公用文の送り仮名に合う"}');
    expect(advice).toEqual({
      choice: "引っ越し",
      noUnify: false,
      reason: "公用文の送り仮名に合う",
    });
  });

  test("もう一方の表記でも通す（多いほうに限らない）", () => {
    expect(parse('{"choice":"引越し","reason":"作品の地の文に合う"}')).toMatchObject(
      { choice: "引越し", noUnify: false }
    );
  });

  test("「揃えない」は答えとして通す", () => {
    // 方言・口癖としてわざと揺らしている場合の答えである。
    // **指示の言葉と同じだが、ここでは中身のある答えである**
    const advice = parse(
      `{"choice":"${NOTATION_ADVICE_NO_UNIFY}","reason":"会話文だけ「引越し」で、話者の癖と読める"}`
    );
    expect(advice?.noUnify).toBe(true);
    expect(advice?.choice).toBe(NOTATION_ADVICE_NO_UNIFY);
  });

  test("「揃えないほうがよい」のような言い足しも、揃えないとして読む", () => {
    expect(parse('{"choice":"揃えないほうがよい","reason":"書き分けている"}')?.noUnify).toBe(
      true
    );
  });

  test("選択肢に無い表記は捨てる", () => {
    // **新しい表記を作ってくることがある。** そのまま出すと、本文に
    // 一度も出ていない書き方へ揃えるよう勧めることになる
    expect(parse('{"choice":"引っ越", "reason":"短いほうがよい"}')).toBeUndefined();
    expect(parse('{"choice":"ひっこし","reason":"読みやすい"}')).toBeUndefined();
  });

  test("鉤括弧や句点が付いていても、表記そのものなら通す", () => {
    expect(parse('{"choice":"「引っ越し」","reason":"公用文に合う"}')).toMatchObject({
      choice: "引っ越し",
    });
  });

  test("choice が無い・文字列でない答えは捨てる", () => {
    expect(parse('{"reason":"公用文に合う"}')).toBeUndefined();
    expect(parse('{"choice":1,"reason":"公用文に合う"}')).toBeUndefined();
  });

  test("JSONとして読めない応答は捨てる", () => {
    expect(parse("よく分かりませんでした")).toBeUndefined();
  });

  test("コードフェンスや前置きが付いていても読む", () => {
    const advice = parse(
      '判断しました。\n```json\n{"choice":"引っ越し","reason":"公用文の送り仮名"}\n```'
    );
    expect(advice?.choice).toBe("引っ越し");
  });
});

/**
 * 数字（と英字）の幅の組。0〜9 の半角・全角をまとめた1組は、表記が最大20個ある。
 * 2026-09-25 夜の実接続で、gemma4:26b が揃え先に「2」と答えた——選べるのが
 * 20個の数字そのものと「揃えない」だけで、「半角」「全角」を選ぶ口が無かった。
 * 画面には「「2」に揃える」と出て、何をすればよいのか分からない。
 */
describe("数字・英字の幅の組", () => {
  const digits: NotationAdviceGroup = {
    label: "半角の数字（0〜9）↔ 全角",
    forms: [
      { surface: "2", count: 5, excerpts: ["2人で歩く"] },
      { surface: "3", count: 2, excerpts: ["3日後"] },
      { surface: "２", count: 9, excerpts: ["２人は笑った"] },
    ],
  };

  test("選べるのは「半角」「全角」だけ（数字そのものは選ばせない）", () => {
    expect(isWidthNotationGroup(digits)).toBe(true);
    expect(notationAdviceChoices(digits)).toEqual([NOTATION_ADVICE_HALF, NOTATION_ADVICE_FULL]);
    const choices = notationAdviceChoices(digits);
    expect(parseNotationAdvice('{"choice":"全角","reason":"縦書きで寝ない"}', choices)).toMatchObject({
      choice: NOTATION_ADVICE_FULL,
      width: "full",
      noUnify: false,
    });
    // 言い足しても指すものは1つ
    expect(parseNotationAdvice('{"choice":"半角に揃える","reason":"横書き"}', choices)).toMatchObject({
      choice: NOTATION_ADVICE_HALF,
      width: "half",
    });
    // 数字そのものを答えたら受け取らない（「2」に揃える、には意味が無い）
    expect(parseNotationAdvice('{"choice":"2","reason":"半角が多い"}', choices)).toBeUndefined();
    expect(parseNotationAdvice('{"choice":"揃えない","reason":"年号だけ半角"}', choices)?.noUnify).toBe(true);
  });

  test("半角だけの組（全角が本文に1度も出ていない）も幅の組", () => {
    const halfOnly = { label: digits.label, forms: [digits.forms[0]] };
    expect(notationAdviceChoices(halfOnly)).toEqual([NOTATION_ADVICE_HALF, NOTATION_ADVICE_FULL]);
  });

  test("英字の幅だけが違う組（AI ↔ ＡＩ）も幅の組。ふつうの組は表記そのもの", () => {
    const alpha = {
      label: "AI ↔ ＡＩ",
      forms: [
        { surface: "AI", count: 4, excerpts: [] },
        { surface: "ＡＩ", count: 1, excerpts: [] },
      ],
    };
    expect(isWidthNotationGroup(alpha)).toBe(true);
    expect(notationAdviceChoices({ label: "", forms: [{ surface: "引っ越し", count: 1, excerpts: [] }, { surface: "引越し", count: 1, excerpts: [] }] })).toEqual(SURFACES);
    // 綴りが違う英字（大文字小文字）は幅の組にしない（「半角」では指すものが決まらない）
    expect(
      isWidthNotationGroup({
        label: "",
        forms: [
          { surface: "AI", count: 1, excerpts: [] },
          { surface: "Ai", count: 1, excerpts: [] },
        ],
      })
    ).toBe(false);
  });
});

describe("reason の中身", () => {
  test("指示の言葉がそのまま返ってきたら、理由は空にする", () => {
    // 答えそのもの（choice）は残す。**理由が無いことと、答えが無いことは違う**
    for (const hint of NOTATION_ADVICE_HINTS) {
      const advice = parse(`{"choice":"引っ越し","reason":${JSON.stringify(hint)}}`);
      expect(advice?.choice, `${hint} が理由として残っている`).toBe("引っ越し");
      expect(advice?.reason, `${hint} が理由として残っている`).toBe("");
    }
  });

  test("「なし」「特になし」も理由として扱わない", () => {
    expect(parse('{"choice":"引っ越し","reason":"特になし"}')?.reason).toBe("");
  });

  test("理由が無くても、答えは捨てない", () => {
    expect(parse('{"choice":"引っ越し"}')).toMatchObject({
      choice: "引っ越し",
      reason: "",
    });
  });
});
