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
  test("起動条件はmanualとPR main向け同期時で、権限はcontents: readだけにする", () => {
    const onEntries = mappingEntries(topLevelBlock(workflow, "on"), 2);
    expect(onEntries).toHaveLength(2);
    expect(onEntries).toEqual(expect.arrayContaining([
      "workflow_dispatch:",
      "pull_request:",
    ]));
    expect(mappingEntries(topLevelBlock(workflow, "permissions"), 2)).toEqual([
      "contents: read",
    ]);
    expect(topLevelBlock(workflow, "on")).not.toContain("  push:");
    expect(topLevelBlock(workflow, "on")).not.toContain("  schedule:");
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
      .filter((line) =>
        line.includes("SAKURA_AI_ACCOUNT_TOKEN") ||
        line.includes("SAKURA_AI_SMOKE_MODEL")
      );
    expect(tokenLines).toEqual([
      "          SAKURA_AI_ACCOUNT_TOKEN: ${{ secrets.SAKURA_AI_ACCOUNT_TOKEN }}",
      "          SAKURA_AI_SMOKE_MODEL: ${{ vars.SAKURA_AI_SMOKE_MODEL }}",
    ]);

    const smokeStep = stepBlocks(workflow).find((step) =>
      step.some((line) => line.trim() === "run: node scripts/sakuraAiSmoke.mjs")
    );
    expect(smokeStep).toContain("        env:");
    expect(smokeStep).toContain(tokenLines[0]);
    expect(smokeStep).toContain(tokenLines[1]);
  });

  test("PR実行はmain向けのopened/reopen/synchronizeのみ、forkは安全のため実行をスキップ", () => {
    const onBlock = topLevelBlock(workflow, "on");
    expect(onBlock).toContain("  pull_request:");
    expect(onBlock).toContain("    branches:");
    expect(onBlock).toContain("      - main");
    expect(onBlock).toContain("    types:");
    expect(onBlock).toContain("      - opened");
    expect(onBlock).toContain("      - synchronize");
    expect(onBlock).toContain("      - reopened");

    const lines = workflow.split(/\r?\n/);
    const ifIndex = lines.findIndex((line) => line.startsWith("    if: >"));
    expect(ifIndex).toBeGreaterThanOrEqual(0);
    const ifBlock = lines.slice(ifIndex, ifIndex + 4).join("\n");
    expect(ifBlock).toContain("github.event_name != 'pull_request'");
    expect(ifBlock).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository"
    );

    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("  group: sakura-smoke-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}");
    expect(workflow).toContain("  cancel-in-progress: true");
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
