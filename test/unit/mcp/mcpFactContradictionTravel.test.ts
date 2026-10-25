import fs from "node:fs";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { STORY_FACT_EXTRACT_SYSTEM_PROMPT } from "../../../src/prompts/storyFactExtract";

/**
 * MCP の口（`novel.run` の factContradiction）が、移動の照合の材料
 * （場所の記録・本文の時計）を製品と同じ関数で組んで照合へ渡しているか（設計書6.88）。
 *
 * AIは作り物にする（単体テストは本物の Ollama へ送らない）。抽出の答えは
 * 旅の台の固定の事実（`facts.json`）を P-37 の形で返し、判定は全部「採用」を返す。
 * **見るのは配線**——精度は `scripts/measure.mjs` が本物のAIで測る。
 */

const WORK = nodePath.join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "seeded",
  "contradiction-travel"
);

interface FixedFact {
  file: string;
  line: number;
  subject: string;
  predicate: string;
  value: string;
  kind: string;
  modality: string;
}

const fixed = JSON.parse(
  fs.readFileSync(nodePath.join(WORK, "facts.json"), "utf8")
).facts as FixedFact[];

/** 各話の1行目（抽出のプロンプトにどの話が載っているかを見分ける） */
const firstLines = fs
  .readdirSync(nodePath.join(WORK, "本文"))
  .map((name) => ({
    file: `本文/${name}`,
    head: fs
      .readFileSync(nodePath.join(WORK, "本文", name), "utf8")
      .split("\n")[0]
      .trim(),
  }));

vi.mock("../../../src/mcp/tools/ollama", () => ({
  ollamaGenerate: vi.fn(async (input: { systemPrompt: string; userPrompt: string }) => {
    if (input.systemPrompt !== STORY_FACT_EXTRACT_SYSTEM_PROMPT) {
      return {
        text: JSON.stringify({ verdict: "採用", explanation: "作り物の判定", confidence: "high" }),
        model: "fake",
      };
    }
    const episode = firstLines.find((entry) => input.userPrompt.includes(entry.head));
    const facts = fixed
      .filter((entry) => entry.file === episode?.file)
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
        // 台詞は誰の発言かが要る（無いと検算が弾く）
        speaker: entry.modality === "dialogue" ? entry.subject : null,
        topic: null,
      }));
    return { text: JSON.stringify({ facts }), model: "fake" };
  }),
}));

describe("事実の照合——移動の照合の配線（MCP）", () => {
  it("場所の記録と本文の時計から、仕込み3件の行に候補を出し、工程の件数を返す", async () => {
    const { factContradictionRun } = await import(
      "../../../src/mcp/tools/factContradiction"
    );
    const outcome = await factContradictionRun({
      folder: WORK,
      numCtx: 32768,
      runner: "ollama",
      model: "fake",
    });
    if (outcome.runner === "claude") throw new Error("ollama で回したはず");

    const flagged = outcome.results.flatMap((result) =>
      result.accepted
        .filter((issue) => issue.category === "時系列")
        .map((issue) => `${nodePath.basename(issue.filePath)}:${issue.line}`)
    );
    expect(flagged.sort()).toEqual([
      "002_港町の市場.txt:8",
      "004_砦からの道.txt:8",
      "006_帰り道.txt:12",
    ]);
    expect(outcome.stages.travel).toEqual({
      whereaboutsFacts: 17,
      resolved: 13,
      clocked: 13,
      tablePairs: 2,
    });
    expect(outcome.note).toContain("所要時間の表 2組");
  });
});
