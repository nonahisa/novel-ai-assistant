import { describe, expect, test } from "vitest";
import {
  readerAimChatLogLine,
  workChatReaderBlocks,
} from "../../../src/core/workChatMaterials";
import {
  buildReaderAimPrompt,
  buildReaderTypePrompt,
  buildReaderTypeUnknownPrompt,
  READER_AIM_HEADING,
} from "../../../src/prompts/readerTarget";
import { AIM_REASON_MAX } from "../../../src/core/targetSheetAdvice";
import { readAim } from "../../../src/core/targetSheetDoc";
import type { ReaderProfile } from "../../../src/models/readerProfile";

/**
 * 相談へ狙いと理由を渡す（設計書6.108.6 の⑤。0.98.8）。
 *
 * 「狙いの理由は、いまはシートに残るだけで、どこにも使っていない」への答え。
 * 相談の材料に、作品のターゲットシートの狙いと理由を**短く**足す。
 */

const DECLARED: ReaderProfile = {
  schemaVersion: "1",
  declared: {
    scores: { familiarity: 6, posture: 3, craving: 0 },
    answers: [2, 2, 2, 1, 1, 1, 0, 0, 0],
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
};

describe("相談の材料に狙いと理由が入る", () => {
  test("狙いと理由があれば、名前と理由を毎回足す（読者の話でない回も）", () => {
    const aim = readAim("狙い：考察層、没入層\n理由：伏線を拾ってくれる人に")!;

    const reader = workChatReaderBlocks(DECLARED, "この場面はどうでしょう", aim);

    const joined = reader.blocks.join("\n\n");
    expect(reader.aim).toBe(true);
    expect(joined).toContain(`${READER_AIM_HEADING}考察層、没入層`);
    expect(joined).toContain("作者が挙げた理由：伏線を拾ってくれる人に");
    // 読者像の段はこれまでどおり（狙いは足すだけで、置き換えない）
    expect(joined).toContain(buildReaderTypePrompt(DECLARED)!);
  });

  test("理由が書かれていなければ、そう書く（理由を作らせない）", () => {
    const aim = readAim("狙い：刺激層\n理由：")!;

    const joined = workChatReaderBlocks(undefined, "この場面", aim).blocks.join("\n");

    expect(joined).toContain("理由は書かれていません。");
  });

  test("読者像が無くても狙いがあれば、「まだ決めていません」は送らない", () => {
    const aim = readAim("狙い：刺激層")!;

    const reader = workChatReaderBlocks(undefined, "この場面", aim);

    expect(reader.blocks).not.toContain(buildReaderTypeUnknownPrompt());
    expect(reader.declared).toBe(false);
    expect(reader.aim).toBe(true);
  });

  test("狙いが無ければ、これまでと同じ材料のまま", () => {
    expect(workChatReaderBlocks(undefined, "この場面").blocks).toEqual([
      buildReaderTypeUnknownPrompt(),
    ]);
    expect(workChatReaderBlocks(undefined, "この場面", readAim("狙い：")).aim).toBe(false);
  });

  test("量は短い（理由は1行に収め、長すぎる手書きは切る）", () => {
    const long = "あ".repeat(AIM_REASON_MAX * 3);
    const aim = readAim(`狙い：考察層\n理由：${long}`)!;

    const block = workChatReaderBlocks(undefined, "この場面", aim).blocks.join("\n");
    const prompt = buildReaderAimPrompt(["lore_deep"], "短い理由");

    expect(block).not.toContain(long);
    expect(block).toContain("…");
    // 2〜3行（名前・理由・断り）に収まる
    expect(prompt.split("\n")).toHaveLength(3);
  });

  test("ログには理由の中身を書かない（字数と有無だけ）", () => {
    const line = readerAimChatLogLine(readAim("狙い：考察層\n理由：秘密の動機")!);
    expect(line).toContain("考察層");
    expect(line).toContain("理由 5字");
    expect(line).not.toContain("秘密の動機");
  });
});
