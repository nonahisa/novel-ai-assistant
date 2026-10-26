import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { STORY_FACT_EXTRACT_SYSTEM_PROMPT } from "../../../src/prompts/storyFactExtract";
import { TRAVEL_DISTANCE_EXTRACT_SYSTEM_PROMPT } from "../../../src/prompts/travelDistanceExtract";
import { SCENE_TIME_CUE_SYSTEM_PROMPT } from "../../../src/prompts/sceneTimeCue";
import {
  TRAVEL_DISTANCE_DISMISSED_FILE,
  travelDistanceDismissKey,
} from "../../../src/core/travelCues";

/**
 * MCP の口（`novel.run` の factContradiction）が、移動の照合の AI の手がかり
 * （P-51 本文の距離・P-52 場面の頭の時の経過。設計書6.88.13）を製品と同じ関数で回し、
 * 読んだ距離を承認待ちへ置くか。
 *
 * AIは作り物（台の `aiCues.json` の正しい答えを返す）。**承認待ちを書くので、台は
 * 一時フォルダーへ写してから回す**（台そのものに `.aiwriter/` を作らない）。
 */

const SOURCE = nodePath.join(__dirname, "..", "..", "fixtures", "seeded", "contradiction-travel-ai");
const WORK = fs.mkdtempSync(nodePath.join(os.tmpdir(), "travel-ai-"));
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
const cues = JSON.parse(fs.readFileSync(nodePath.join(SOURCE, "aiCues.json"), "utf8")) as {
  distances: Array<{ file: string }>;
  timeCues: Array<{ file: string; line: number }>;
};
const texts = new Map(
  fs
    .readdirSync(nodePath.join(SOURCE, "本文"))
    .map((name) => [`本文/${name}`, fs.readFileSync(nodePath.join(SOURCE, "本文", name), "utf8")])
);
const fileOfPrompt = (prompt: string) =>
  [...texts].find(([, text]) => prompt.includes(text.split("\n")[0].trim()))?.[0];

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
    if (input.systemPrompt === TRAVEL_DISTANCE_EXTRACT_SYSTEM_PROMPT) {
      const file = fileOfPrompt(input.userPrompt);
      return {
        text: JSON.stringify({ distances: cues.distances.filter((answer) => answer.file === file) }),
        model: "fake",
      };
    }
    if (input.systemPrompt === SCENE_TIME_CUE_SYSTEM_PROMPT) {
      const answer = cues.timeCues.find((cue) => {
        const head = (texts.get(cue.file) ?? "").split("\n")[cue.line - 1];
        return input.userPrompt.includes(`## この場面の頭\n${head}`);
      });
      return { text: JSON.stringify(answer ?? { kind: null, days: 0, evidence: "" }), model: "fake" };
    }
    return {
      text: JSON.stringify({ verdict: "採用", explanation: "作り物の判定", confidence: "high" }),
      model: "fake",
    };
  }),
}));

describe("事実の照合——移動の照合の AI の手がかり（MCP）", () => {
  it("本文の距離と場面の頭の時の経過から仕込み3件に当て、距離を承認待ちへ置く", async () => {
    const { factContradictionRun } = await import("../../../src/mcp/tools/factContradiction");
    const run = () =>
      factContradictionRun({ folder: WORK, numCtx: 32768, runner: "ollama", model: "fake" });
    const outcome = await run();
    if (outcome.runner === "claude") throw new Error("ollama で回したはず");

    const flagged = outcome.results.flatMap((result) =>
      result.accepted
        .filter((issue) => issue.category === "時系列")
        .map((issue) => `${nodePath.basename(issue.filePath)}:${issue.line}`)
    );
    expect(flagged.sort()).toEqual([
      "001_馬で三日.txt:8",
      "002_二日目の砦.txt:7",
      "003_城門へ帰る.txt:1",
    ]);
    // 根拠に「承認待ち」が出る（作者の判断②）
    for (const result of outcome.results) {
      for (const issue of result.accepted) expect(issue.settingSays).toContain("承認待ち");
    }
    expect(outcome.stages.travel.aiCues).toMatchObject({
      distancesAccepted: 3,
      proposedLocations: 2,
      timeCuesApplied: 2,
    });
    expect(outcome.pendingProposals.sort()).toEqual([
      ".aiwriter/pending-settings/loc_0001.json",
      ".aiwriter/pending-settings/loc_0002.json",
    ]);

    const pending = JSON.parse(
      fs.readFileSync(nodePath.join(WORK, ".aiwriter", "pending-settings", "loc_0001.json"), "utf8")
    ) as { source: string; reason: string; record: { relations: Array<{ target: string }> } };
    expect(pending.source).toBe("fact");
    expect(pending.record.relations.map((relation) => relation.target)).toEqual(["港町", "北の砦"]);
    expect(pending.reason).toContain("事実の照合で本文「王都から港町までは、馬で三日の道のりだ」（第1話）");

    // 台帳そのもの（設定/locations）は書き換えない
    expect(
      JSON.parse(fs.readFileSync(nodePath.join(WORK, "設定", "locations", "loc_0001.json"), "utf8"))
        .relations
    ).toBeUndefined();

    // もう一度回しても、同じ案は合わさるだけで二重にならない
    await run();
    const again = JSON.parse(
      fs.readFileSync(nodePath.join(WORK, ".aiwriter", "pending-settings", "loc_0001.json"), "utf8")
    ) as { reason: string; record: { relations: unknown[] } };
    expect(again.record.relations).toHaveLength(2);
    expect(again.reason).toBe(pending.reason);
  });

  /**
   * 作者が拡張機能の提案パネルで見送った距離は、MCP の口でも出さない
   * （作者の裁定 2026-10-26「見送ったものはもう出さない」。控えは製品と同じファイル）
   */
  it("見送った距離の控えがあれば、その距離は提案せず照合にも使わない", async () => {
    const work = fs.mkdtempSync(nodePath.join(os.tmpdir(), "travel-ai-dismissed-"));
    try {
      fs.cpSync(SOURCE, work, { recursive: true });
      const cache = nodePath.join(work, ".aiwriter", "cache");
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(
        nodePath.join(cache, TRAVEL_DISTANCE_DISMISSED_FILE),
        JSON.stringify([travelDistanceDismissKey("loc_0001", "loc_0002", "馬で三日")]),
        "utf8"
      );
      const { factContradictionRun } = await import("../../../src/mcp/tools/factContradiction");
      const outcome = await factContradictionRun({
        folder: work,
        numCtx: 32768,
        runner: "ollama",
        model: "fake",
      });
      if (outcome.runner === "claude") throw new Error("ollama で回したはず");

      expect(outcome.stages.travel.aiCues).toMatchObject({ distancesAccepted: 2, distancesDismissed: 1 });
      const pending = JSON.parse(
        fs.readFileSync(nodePath.join(work, ".aiwriter", "pending-settings", "loc_0001.json"), "utf8")
      ) as { record: { relations: Array<{ target: string }> } };
      expect(pending.record.relations.map((relation) => relation.target)).toEqual(["北の砦"]);
      const flagged = outcome.results.flatMap((result) =>
        result.accepted.map((issue) => `${nodePath.basename(issue.filePath)}:${issue.line}`)
      );
      expect(flagged).not.toContain("001_馬で三日.txt:8");
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
