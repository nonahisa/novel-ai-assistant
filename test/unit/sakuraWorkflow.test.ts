import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/sakura-ai-smoke.yml", import.meta.url)
);

let workflow = "";

beforeAll(async () => {
  workflow = await readFile(WORKFLOW_PATH, "utf8");
});

describe("Sakura AI smoke workflow", () => {
  test("起動条件はworkflow_dispatchだけで権限はcontents: readだけにする", () => {
    expect(mappingEntries(topLevelBlock(workflow, "on"), 2)).toEqual([
      "workflow_dispatch:",
    ]);
    expect(mappingEntries(topLevelBlock(workflow, "permissions"), 2)).toEqual([
      "contents: read",
    ]);
  });

  test("checkout v4とsetup-node v4のNode 22だけで実行環境を準備する", () => {
    expect(topLevelBlock(workflow, "jobs")).toContain(
      "    timeout-minutes: 5"
    );
    const steps = stepBlocks(workflow);
    const uses = steps.flatMap((step) =>
      step.flatMap((line) => {
        const match = line.match(/^\s*-\s+uses:\s*(\S+)\s*$/);
        return match ? [match[1]] : [];
      })
    );
    expect(uses).toEqual(["actions/checkout@v4", "actions/setup-node@v4"]);

    const setupNode = steps.find((step) =>
      step.some((line) => line.trim() === "- uses: actions/setup-node@v4")
    );
    expect(setupNode).toContain("        with:");
    expect(setupNode).toContain("          node-version: 22");
  });

  test("アカウントトークンはスモーク実行stepだけに渡す", () => {
    const tokenLines = workflow
      .split(/\r?\n/)
      .filter((line) => line.includes("SAKURA_AI_ACCOUNT_TOKEN"));
    expect(tokenLines).toEqual([
      "          SAKURA_AI_ACCOUNT_TOKEN: ${{ secrets.SAKURA_AI_ACCOUNT_TOKEN }}",
    ]);

    const smokeStep = stepBlocks(workflow).find((step) =>
      step.some((line) => line.trim() === "run: node scripts/sakuraAiSmoke.mjs")
    );
    expect(smokeStep).toContain("        env:");
    expect(smokeStep).toContain(tokenLines[0]);
  });
});

function topLevelBlock(source: string, key: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return [];
  const end = lines.findIndex(
    (line, index) => index > start && /^[^\s#][^:]*:/.test(line)
  );
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function mappingEntries(lines: string[], spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return lines
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix} `))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function stepBlocks(source: string): string[][] {
  const lines = source.split(/\r?\n/);
  const starts = lines.flatMap((line, index) =>
    /^ {6}-\s+/.test(line) ? [index] : []
  );
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length)
  );
}
