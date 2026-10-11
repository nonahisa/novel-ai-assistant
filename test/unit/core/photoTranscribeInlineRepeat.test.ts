import { describe, expect, test } from "vitest";
import {
  INLINE_REPEAT_STOP_NOTE,
  parsePhotoTranscriptionStoppingRepeats,
} from "../../../src/core/photoTranscribeValidation";

/**
 * 写真の書き起こしの受け取りで、1行の中の繰り返しを切り詰める（残課題 A17、2026-10-11）。
 *
 * 流さないAIは上限まで書いた答えを返すので、届いたあとで切る。
 * 測定（gemma4:26b、逆さの写真）では、同じ9字を903回書いて JSON が閉じずに切れた。
 */

const UNIT = "の上に立つ彼女は、";

describe("届いた答えの切り詰め", () => {
  test("上限で切れた903回の例：1つ目の並びまでを残して読む", () => {
    const raw =
      '{"lines":[{"text":"私は窓の外を見ていた。"},{"text":"机' + UNIT.repeat(903).slice(0, -2);
    const { parse, repeatStopped } = parsePhotoTranscriptionStoppingRepeats(raw);
    expect(repeatStopped).toBe(true);
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.value.text).toBe(`私は窓の外を見ていた。\n机${UNIT}`);
  });

  test("書き切った答えの中の繰り返しも切る（あとの行は捨てる）", () => {
    const raw = JSON.stringify({
      lines: [{ text: "一行目" }, { text: `二行目${UNIT.repeat(40)}` }, { text: "三行目" }],
    });
    const { parse, repeatStopped } = parsePhotoTranscriptionStoppingRepeats(raw);
    expect(repeatStopped).toBe(true);
    expect(parse.ok && parse.value.text).toBe(`一行目\n二行目${UNIT}`);
  });

  test("繰り返しだけで1行も残らなければ、止めたことを理由にして返す", () => {
    const raw = `{"lines":[{"text":"${UNIT.repeat(100)}`;
    // 1つ目の並びは残るので、読める。並びの前に何も無い、もう一段短い形を作る
    const { parse, repeatStopped } = parsePhotoTranscriptionStoppingRepeats(raw);
    expect(repeatStopped).toBe(true);
    expect(parse.ok && parse.value.text).toBe(UNIT);

    const broken = `xx${"ab".repeat(30)}`;
    const result = parsePhotoTranscriptionStoppingRepeats(broken);
    expect(result.repeatStopped).toBe(true);
    expect(result.parse.ok).toBe(false);
    if (result.parse.ok) return;
    expect(result.parse.reason).toBe(INLINE_REPEAT_STOP_NOTE);
  });

  test("正常な答え・作者の表現（「ああああ」「わんわん」）では止めない", () => {
    const raw = JSON.stringify({
      lines: [
        { text: "「ああああああああああああああああああああああああ」" },
        { text: "犬がわんわんわんわんわんわんわんわんと鳴いた。" },
        { text: "〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓〓" },
        { text: "　雨が降っていた。雨が降っていた。雨が降っていた。" },
      ],
    });
    const { parse, repeatStopped } = parsePhotoTranscriptionStoppingRepeats(raw);
    expect(repeatStopped).toBe(false);
    expect(parse.ok && parse.value.text.split("\n")).toHaveLength(4);
  });
});
