import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/sakura-ai-smoke.yml", import.meta.url)
);

describe("Sakura AI smoke workflow", () => {
  test("手動実行だけを許可し、最小権限でシークレットを煙検証へ渡す", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("timeout-minutes: 5");
    expect(workflow).toContain(
      "SAKURA_AI_ACCOUNT_TOKEN: ${{ secrets.SAKURA_AI_ACCOUNT_TOKEN }}"
    );
    expect(workflow).toContain("node scripts/sakuraAiSmoke.mjs");
    expect(workflow).not.toContain("push:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("schedule:");
  });
});
