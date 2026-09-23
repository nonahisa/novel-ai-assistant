import { describe, expect, test } from "vitest";
import { READER_TYPES, type ReaderTypeId } from "../../../src/core/readerTarget";
import { titleFitTargets } from "../../../src/core/titleFit";
import {
  buildTitleFitPrompt,
  TITLE_FIT_SCHEMA,
  TITLE_FIT_SYSTEM_PROMPT,
  TITLE_FIT_VERSION,
} from "../../../src/prompts/titleFit";

/**
 * P-41 タイトルとサブタイトルの適合度（設計書6.108.6）。
 *
 * **答えの中身は見張れない。** ここで確かめられるのは渡す側だけである
 * ——測る相手の層が1つだけ入っていること、書き換え案を頼んでいないこと、
 * 渡した題がすべて並んでいること。
 */
const TARGETS = titleFitTargets("鉛の海", [
  { label: "第1話", title: "目覚め" },
  { label: "第2話", title: "錆びた港" },
]);

describe("P-41 の組み立て", () => {
  test("版を持つ（変えたら上げる）", () => {
    expect(TITLE_FIT_VERSION).toMatch(/^\d+\.\d+$/);
  });

  test("測る相手の層は1つだけ（ほかの層の名前を混ぜない）", () => {
    const prompt = buildTitleFitPrompt({ readerType: "lore_deep", targets: TARGETS });

    expect(prompt).toContain(READER_TYPES.lore_deep.label);
    expect(prompt).toContain(READER_TYPES.lore_deep.works);
    for (const id of Object.keys(READER_TYPES) as ReaderTypeId[]) {
      if (id === "lore_deep") continue;
      expect(prompt, id).not.toContain(READER_TYPES[id].label);
    }
  });

  test("渡した題がすべて、id と一緒に並ぶ", () => {
    const prompt = buildTitleFitPrompt({ readerType: "light", targets: TARGETS });

    for (const target of TARGETS) {
      expect(prompt).toContain(`${target.id}（${target.label}）：${target.text}`);
    }
  });

  test("書き換え案も、良し悪しも頼まない", () => {
    expect(TITLE_FIT_SYSTEM_PROMPT).toContain("書き換え案を出さないこと");
    expect(TITLE_FIT_SYSTEM_PROMPT).toContain("良し悪しを言わないこと");
    expect(TITLE_FIT_SYSTEM_PROMPT).toContain("目安");
  });

  test("答えの形は id・score・comment（すべて必須）", () => {
    const item = TITLE_FIT_SCHEMA.properties.items.items;
    expect(item.required).toEqual(["id", "score", "comment"]);
    expect(item.properties.score.type).toBe("integer");
  });
});
