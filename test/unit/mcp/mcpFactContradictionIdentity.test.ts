import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { STORY_FACT_EXTRACT_SYSTEM_PROMPT } from "../../../src/prompts/storyFactExtract";
import { SCENE_MIND_EXTRACT_SYSTEM_PROMPT } from "../../../src/prompts/sceneMindExtract";
import {
  CONTRADICTION_VERIFY_SYSTEM_PROMPT,
  VERIFY_IDENTITY_SOURCE_NOTE,
} from "../../../src/prompts/contradictionVerify";

/**
 * MCP の口（`novel.run` の factContradiction）が、体と心の照合（P-53 場面の体と心。
 * 設計書6.88.14）を製品と同じ関数で回し、仕込みに当たって罠に当たらないか。
 *
 * AIは作り物（台の `facts.json`・`identityCues.json` の正しい答えを返す）。台は一時フォルダーへ
 * 写してから回す（台そのものに `.aiwriter/` を作らない）。
 */

const SOURCE = nodePath.join(__dirname, "..", "..", "fixtures", "seeded", "contradiction-identity");
const WORK = fs.mkdtempSync(nodePath.join(os.tmpdir(), "identity-"));
fs.cpSync(SOURCE, WORK, { recursive: true });

afterAll(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

interface FixedFact {
  file: string;
  line: number;
  subject: string;
  predicate: string;
  value: string;
  kind: string;
  modality: string;
}

const fixed = JSON.parse(fs.readFileSync(nodePath.join(SOURCE, "facts.json"), "utf8"))
  .facts as FixedFact[];
const cues = JSON.parse(fs.readFileSync(nodePath.join(SOURCE, "identityCues.json"), "utf8")) as {
  minds: Array<{ file: string }>;
  transitions: Array<{ file: string }>;
};
const texts = new Map(
  fs
    .readdirSync(nodePath.join(SOURCE, "本文"))
    .map((name) => [`本文/${name}`, fs.readFileSync(nodePath.join(SOURCE, "本文", name), "utf8")])
);
const fileOfPrompt = (prompt: string) =>
  [...texts].find(([, text]) => prompt.includes(text.split("\n")[0].trim()))?.[0];

/** 確かめの段へ送った頼み（体と心の文面が届いているかを見る） */
const verifyPrompts: string[] = [];

vi.mock("../../../src/mcp/tools/ollama", () => ({
  ollamaGenerate: vi.fn(async (input: { systemPrompt: string; userPrompt: string }) => {
    if (input.systemPrompt === STORY_FACT_EXTRACT_SYSTEM_PROMPT) {
      const file = fileOfPrompt(input.userPrompt);
      const facts = fixed
        .filter((entry) => entry.file === file)
        .map((entry) => ({
          line_start: entry.line,
          line_end: entry.line,
          subject: entry.subject,
          predicate: entry.predicate,
          value: entry.value,
          kind: entry.kind,
          story_time: null,
          modality: entry.modality,
          pov: null,
          speaker: entry.modality === "dialogue" ? entry.subject : null,
          topic: null,
        }));
      return { text: JSON.stringify({ facts }), model: "fake" };
    }
    if (input.systemPrompt === SCENE_MIND_EXTRACT_SYSTEM_PROMPT) {
      const file = fileOfPrompt(input.userPrompt);
      return {
        text: JSON.stringify({
          minds: cues.minds.filter((answer) => answer.file === file),
          transitions: cues.transitions.filter((answer) => answer.file === file),
        }),
        model: "fake",
      };
    }
    if (input.systemPrompt === CONTRADICTION_VERIFY_SYSTEM_PROMPT) verifyPrompts.push(input.userPrompt);
    return {
      text: JSON.stringify({ verdict: "採用", reason: "", explanation: "作り物の判定", confidence: "high" }),
      model: "fake",
    };
  }),
}));

describe("事実の照合——体と心の照合（MCP）", () => {
  it("心と体の記録と場面の読みから仕込み3件に当て、罠には当てない", async () => {
    const before = fs.readFileSync(nodePath.join(WORK, "設定", "characters", "char_0002.json"), "utf8");
    const { factContradictionRun } = await import("../../../src/mcp/tools/factContradiction");
    const outcome = await factContradictionRun({
      folder: WORK,
      numCtx: 32768,
      runner: "ollama",
      model: "fake",
    });
    if (outcome.runner === "claude") throw new Error("ollama で回したはず");

    const flagged = outcome.results.flatMap((result) =>
      result.accepted.map((issue) => `${nodePath.basename(issue.filePath)}:${issue.line}`)
    );
    expect(flagged.sort()).toEqual(["002_目覚め.txt:11", "005_台所.txt:1", "006_名乗り.txt:6"]);
    expect(outcome.stages.identity).toMatchObject({
      noDwellings: false,
      pairs: 2,
      chunks: 6,
      readings: 11,
      transitions: 4,
      reassignedFacts: 3,
      excludedFacts: 2,
      unrecordedTotal: 2,
    });
    expect(outcome.note).toContain("体と心の照合（心と体の記録 2組");
    expect(outcome.note).toContain("が心と体の記録にありません");

    // 体と心の候補の確かめには identity の文面と、心と体の記録・コードの読みが届く
    const identityPrompts = verifyPrompts.filter((prompt) => prompt.includes(VERIFY_IDENTITY_SOURCE_NOTE));
    expect(identityPrompts).toHaveLength(2);
    expect(identityPrompts[0]).toContain("【心と体の記録】");
    expect(identityPrompts[0]).toContain("【コードの読み】");
    expect(identityPrompts[0]).not.toContain("まだ明かされていない");

    // 人物の記録（作者のデータ）は書き換えない
    expect(fs.readFileSync(nodePath.join(WORK, "設定", "characters", "char_0002.json"), "utf8")).toBe(before);
  });
});
