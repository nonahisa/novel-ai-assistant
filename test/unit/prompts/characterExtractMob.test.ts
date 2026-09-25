import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { validateCharacterExtractResult } from "../../../src/core/characterExtractionValidation";
import { buildCharacterExtractPrompt } from "../../../src/prompts/characterExtract";

/**
 * P-04a 5.8：isMob（端役の印）の意味をAIへ伝える（2026-09-26 精査 R5）。
 *
 * スキーマに `isMob: boolean` があるだけで説明が無いのに、AIが true を
 * 付けた人物は一覧の脇へ回り、矛盾検知やあらすじの材料からも外れていた。
 * 線引きは設計書6.5.2 の表のとおりで、新しい方針は作らない。
 */

const prompt = buildCharacterExtractPrompt({
  chunkText: "（本文）",
  chapterLabel: "第1話",
  knownCharacterNames: [],
});

/** 人物の抽出ルールの節だけ */
const personRules = prompt.slice(
  prompt.indexOf("【登場人物の抽出ルール】"),
  prompt.indexOf("【呼称の抽出ルール")
);

/** isMob の説明の段（次の「- 」で始まる規則の手前まで） */
const mobRule = (() => {
  const start = personRules.indexOf("- isMob");
  const next = personRules.indexOf("\n- ", start + 1);
  return personRules.slice(start, next < 0 ? undefined : next);
})();

const chunk: Chunk = {
  index: 0,
  text: "",
  hash: "h",
  chapterStart: 1,
  chapterEnd: 1,
  filePaths: ["第1話.txt"],
} as unknown as Chunk;

describe("isMob（端役の印）の説明", () => {
  test("人物の抽出ルールに、何を true・何を false にするかが書いてある", () => {
    expect(mobRule.length).toBeGreaterThan(0);
    const flat = mobRule.replace(/[\s*]/gu, "");
    expect(flat).toContain("特定の一人に決まらない");
    expect(flat).toContain("true：");
    expect(flat).toContain("false：");
    // 設計書6.5.2 の3行目：無名でも同じ一人を指すなら個人
    expect(flat).toContain("一貫して同じ一人を指す人物もfalse");
  });

  /*
    指示に書いた例の言葉は、そのまま答えに返ってくる前提で見張る
    （CLAUDE.md「繰り返し起きた失敗」3番）。例は形（「〜たち」）だけに
    してあるが、それが名前として返ってきても本文照合で落ちることを確かめる
  */
  test("説明の中の「」の語が本文に無いまま返ってきたら、検算が落とす", () => {
    const examples = [...mobRule.matchAll(/「([^「」]+)」/gu)].map(
      (match) => match[1]
    );
    expect(examples.length).toBeGreaterThan(0);
    const text = "灯は縁側で空を見ていた。";
    for (const name of examples) {
      const result = validateCharacterExtractResult(
        { characters: [{ name, isMob: true, evidence: text }] } as never,
        { ...chunk, text }
      );
      expect(result.accepted, name).toEqual([]);
    }
  });

  test("説明の語（true／false）が文字列で返ってきても、端役の印にしない", () => {
    // 真偽値でない値は採らない。指示の「true」を文字で写した答えで、
    // 名前のある人物が一覧の脇へ回らないように
    const text = "灯は縁側で空を見ていた。";
    const result = validateCharacterExtractResult(
      {
        characters: [{ name: "灯", isMob: "true", evidence: text }],
      } as never,
      { ...chunk, text }
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.isMob).not.toBe(true);
  });

  test("「〜たち」の集団は、AIが印を付け忘れても端役として残る", () => {
    // 検算の側の決まり（設計書6.5.2。消さずに印で分ける）が
    // 説明を足したあとも変わっていないことの確認
    const text = "兵士たちが門の前に並んでいた。";
    const result = validateCharacterExtractResult(
      {
        characters: [
          { name: "兵士たち", entityType: "group", isMob: false, evidence: text },
        ],
      } as never,
      { ...chunk, text }
    );
    expect(result.accepted.map((c) => [c.data.name, c.data.isMob])).toEqual([
      ["兵士たち", true],
    ]);
  });
});
