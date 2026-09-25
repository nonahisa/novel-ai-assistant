import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { validateCharacterExtractResult } from "../../../src/core/characterExtractionValidation";
import { buildCharacterExtractPrompt } from "../../../src/prompts/characterExtract";

/**
 * P-04a 5.7：家族関係語でしか呼ばれない人物を、指示で消さない
 * （2026-09-25 精査 F7。縛りの洗い出し `2026-09-24-constraint-audit.md`）。
 *
 * 作者の裁定は「おばあさん」「〇〇の母」のように**それしか呼び名の無い人物は
 * 残す**（2026-09-08「「〇〇の母」は必要です」）。検算はそう直してあるのに、
 * AIへの指示には「家族関係語は人物レコードを作らないこと」が残っていた。
 * **AIが指示に忠実なほど、こうした人物が最初の段で消える**——検算で残す
 * 側へ倒しても、そもそも返ってこない。
 */

const prompt = buildCharacterExtractPrompt({
  chunkText: "（本文）",
  chapterLabel: "第1話",
  knownCharacterNames: [],
});

/** 人物の抽出ルールの節だけ（能力・組織の節の「家族」と混ぜない） */
const personRules = prompt.slice(
  prompt.indexOf("【登場人物の抽出ルール】"),
  prompt.indexOf("【呼称の抽出ルール")
);

const chunk: Chunk = {
  index: 0,
  text: "",
  hash: "h",
  chapterStart: 1,
  chapterEnd: 1,
  filePaths: ["第1話.txt"],
} as unknown as Chunk;

describe("家族関係語でしか呼ばれない人物", () => {
  test("人物を作らない語の並びに、家族関係語を入れない", () => {
    // 文は行をまたぐので、句点で切って見る
    const banned = personRules
      .split("。")
      .map((sentence) => sentence.replace(/\s+/gu, ""))
      .filter((sentence) => sentence.includes("人物レコードを作らない"));
    expect(banned.length).toBeGreaterThan(0);
    for (const line of banned) expect(line).not.toContain("家族関係語");
  });

  test("それしか呼び名が無ければ人物として出す、と書いてある", () => {
    expect(personRules).toContain("家族関係語");
    // 強調の「**」を外して見る（文面の飾りで見張りが外れないように）
    expect(personRules.replace(/\*/gu, "")).toContain("呼び名がそれしか無い");
  });

  /*
    指示に書いた例の言葉は、そのまま答えに返ってくる前提で見張る
    （CLAUDE.md「繰り返し起きた失敗」3番）。本文に無い「おばあさん」が
    返ってきても、検算が本文との照合で落とすことを確かめる
  */
  test("例に書いた呼び名が本文に無いまま返ってきたら、検算が落とす", () => {
    const examples = [...personRules.matchAll(/「([^「」]+)」/gu)]
      .map((match) => match[1])
      .filter((word) => /おばあさん|の母/u.test(word));
    expect(examples.length).toBeGreaterThan(0);
    const text = "灯は縁側で空を見ていた。";
    for (const name of examples) {
      const result = validateCharacterExtractResult(
        { characters: [{ name, evidence: text }] } as never,
        { ...chunk, text }
      );
      expect(result.accepted, name).toEqual([]);
    }
  });
});
