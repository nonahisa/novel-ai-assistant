import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "vitest";

/**
 * 全体像の各話あらすじを問いに合わせて選ぶ手がかり（`workChatOverviewFocus`）を、
 * **製品の相談パネルと MCP の相談の両方が渡している**か（2026-10-01）。
 *
 * 片方だけ渡すと、外から測った相談の材料が製品と違う（CLAUDE.md の失敗5）。
 * 組み方は `core/chatFileRequest.ts` の1か所なので、ここで見るのは配線だけ。
 */
const root = join(__dirname, "..", "..", "..");
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("全体像の手がかりの配線", () => {
  test("製品の相談パネルは、問いを送るときに手がかりを渡す", () => {
    const source = read("src/features/workChatPanel.ts");
    expect(source).toContain("workChatOverviewFocus(question, this.history)");
    expect(source).toContain("formatChatOverview({ episodes, documents, focus })");
  });

  test("MCP の相談も同じ手がかりを渡す", () => {
    const source = read("src/mcp/tools/chat.ts");
    expect(source).toContain("workChatOverviewFocus(input.question, history)");
    expect(source).toContain("formatChatOverview({ episodes: episodeHintsOf(folder), documents, focus })");
  });
});
