import { describe, expect, test } from "vitest";
import {
  checkEnrichProposals,
  clampEnrichField,
} from "../../../src/core/settingsEnrichCheck";
import { emptyCharacter } from "../../../src/models/character";
import {
  buildEnrichSchema,
  enrichableFields,
} from "../../../src/prompts/settingsEnrich";
import { SPEECH_STYLE_MAX_CHARS } from "../../../src/core/speechStyle";

/**
 * AIで再読込の口調の案（作者の裁定 2026-10-17「両方直す」。測定 A22・505）。
 *
 * 1. 口調の案が60字の途中で切れていた（e4b のエルシー「…語尾が幼」・26b のガイ）。
 *    送るスキーマの maxLength 60 で Ollama が書くのを途中で止めるので、
 *    句読点まで戻す製品の切り詰めが働かなかった
 * 2. 口調の案の中の一人称を検算していなかった（26b がアジャーノの案に、第12話の
 *    皇子の一人称「余」を入れた）
 */

const speechField = () => {
  const field = enrichableFields("character").find((item) => item.key === "speechStyle");
  if (!field) throw new Error("口調の欄が無い");
  return field;
};

describe("口調の案の長さ", () => {
  test("送るスキーマは、口調を60字ちょうどで止めない（文の切れ目までコードで戻すため）", () => {
    const schema = buildEnrichSchema("character") as {
      properties: Record<string, { maxLength?: number }>;
    };
    const max = schema.properties.speechStyle.maxLength;
    expect(max === undefined || max > SPEECH_STYLE_MAX_CHARS).toBe(true);
  });

  test("上限を超えた案は、途中の語ではなく文の切れ目（句点）で切る", () => {
    // e4b のエルシーの案（実測は60字目「幼」で途切れた）の、書き切った形
    const value =
      "一人称は「ボク」。語尾は「〜です」「〜ます」といった丁寧語と、" +
      "親しい間柄での砕けた口調が混じる。感情が高ぶると、語尾が幼くなる。";
    expect([...value].length).toBeGreaterThan(SPEECH_STYLE_MAX_CHARS);
    const clamped = clampEnrichField(speechField(), value);
    expect([...clamped].length).toBeLessThanOrEqual(SPEECH_STYLE_MAX_CHARS);
    expect(clamped.endsWith("。")).toBe(true);
    expect(clamped).toBe(
      "一人称は「ボク」。語尾は「〜です」「〜ます」といった丁寧語と、親しい間柄での砕けた口調が混じる。"
    );
  });

  test("句点が前寄りにしか無くても、読点で文の途中を切らずに句点まで戻す", () => {
    // 26b のガイの案の形（2文目が長く、読点しか無い）
    const value =
      "一人称は使わない。主を呼ぶときは「主よ」と呼びかけ、" +
      "『〜である』『〜であろう』と古風に言い切り、感情をほとんど表に出さず、淡々と話す。";
    expect([...value].length).toBeGreaterThan(SPEECH_STYLE_MAX_CHARS);
    expect(clampEnrichField(speechField(), value)).toBe("一人称は使わない。");
  });

  test("句点が1つも無ければ読点まで戻し、読点を句点に替えて文を閉じる", () => {
    const value =
      "主を呼ぶときは「主よ」と呼びかけ、『〜である』『〜であろう』と古風に言い切り、" +
      "感情をほとんど表に出さず淡々と話し、ほかの者には短く命じる";
    const clamped = clampEnrichField(speechField(), value);
    expect([...clamped].length).toBeLessThanOrEqual(SPEECH_STYLE_MAX_CHARS);
    expect(clamped).toBe(
      "主を呼ぶときは「主よ」と呼びかけ、『〜である』『〜であろう』と古風に言い切り、感情をほとんど表に出さず淡々と話し。"
    );
  });

  test("括弧の中の句点では切らない（e4b のガイの形：台詞の引用が続く案）", () => {
    // 実測（2026-10-17、e4b）：台詞を引いた案が上限を超え、「…など、」で終わった
    const value =
      "『主よ。何用か』『あいつらは塩振ってブレスで焼いたらうまいのである！ いくらでも食えるのである！』など、" +
      "語尾に「である」を付けて尊大に言い切る";
    const clamped = clampEnrichField(speechField(), value);
    expect(clamped.endsWith("、")).toBe(false);
    expect(clamped.endsWith("など。")).toBe(true);
  });

  test("上限以内の案はそのまま", () => {
    expect(clampEnrichField(speechField(), "一人称は「ボク」。快活な口調。")).toBe(
      "一人称は「ボク」。快活な口調。"
    );
  });
});

/** 台E（ハイエルフ未亡人）のアジャーノ・エルシーの場面を縮めたもの */
const EXCERPTS = [
  "「俺じゃ相手にもならなかったわけだが」",
  "　アジャーノは槍を構え直した。",
  "「アジャーノさん、余計なことを言わないでください」",
  "「ボクって、そんなにドジですか？」",
  "　余は先生の話をただ聞いていた。",
].join("\n");

function check(speechStyle: string) {
  return checkEnrichProposals({
    kind: "character",
    record: emptyCharacter("char_007", "アジャーノ"),
    customFields: [],
    parsed: { speechStyle },
    excerptText: EXCERPTS,
    knownChapters: new Set(),
  });
}

describe("口調の案の中の一人称", () => {
  test("26b のアジャーノの案（「場面により余」）は、台詞に「余」が無いので出さない", () => {
    const result = check(
      "一人称は俺、場面により余。基本は敬語だが、親しい相手や特定の相手には敬語を外す。"
    );
    expect(result.proposals.find((item) => item.field.key === "speechStyle")).toBeUndefined();
    expect(result.speechUnspokenFirstPersons).toEqual(["余"]);
  });

  test("地の文にだけある一人称は、台詞に実在するとみなさない", () => {
    // 「余は先生の話を…」は地の文。「余計な」の「余」は一人称ではない
    const result = check("一人称は「余」。尊大な話し方。");
    expect(result.proposals).toHaveLength(0);
  });

  test("台詞にある一人称なら通す（括弧つき・括弧なし・かなの違い）", () => {
    expect(check("一人称は「俺」。ぶっきらぼう。").proposals).toHaveLength(1);
    expect(check("一人称はボク。快活で親しみやすい口調。").proposals).toHaveLength(1);
    expect(check("一人称は「おれ」。").proposals).toHaveLength(1);
  });

  test("一人称を書いていない案・否定で書いた案は、一人称では落とさない", () => {
    expect(check("丁寧な言葉遣いを基本とする。").proposals).toHaveLength(1);
    expect(
      check("一人称は「わし」ではない。「〜である」と言い切る。").proposals
    ).toHaveLength(1);
  });

  test("語尾の括弧（「〜だな」）を一人称と読まない", () => {
    expect(check("一人称は俺で、語尾に「〜だな」を付ける。").proposals).toHaveLength(1);
  });
});
