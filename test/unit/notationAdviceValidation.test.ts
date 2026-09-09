import { describe, expect, test } from "vitest";
import { parseNotationAdvice } from "../../src/core/notationAdviceValidation";
import {
  NOTATION_ADVICE_HINTS,
  NOTATION_ADVICE_NO_UNIFY,
} from "../../src/prompts/notationAdvice";

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
