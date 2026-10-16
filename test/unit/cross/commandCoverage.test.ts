import { describe, expect, test } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";
import { COMMAND_COVERAGE } from "../../../src/core/commandCoverage";
import { RUN_REQUESTABLE_FEATURES } from "../../../src/core/runRequest";

/**
 * コマンドごとの区分の表の見張り（設計書6.87.24。作者の裁定 2026-10-16 の7
 * 「区分の表と見張りのテストを1件目と一緒に入れる」）。
 *
 * **新しいコマンドを足して表に書き忘れたら、ここで落ちる。** 書き忘れたまま
 * 通ると、そのコマンドは外部AIから届くかどうかを誰も決めないまま残る
 * ——壊れはしないが、作者からは「なぜ外部AIに頼めないのか」が分からない。
 *
 * 落ちたら `src/core/commandCoverage.ts` に1行足し、区分を決める（分からなければ
 * 外部AIに渡さない C4 にして、理由の種類を書く）。
 */

const root = nodePath.join(__dirname, "../../..");
const pkg = JSON.parse(fs.readFileSync(nodePath.join(root, "package.json"), "utf8")) as {
  contributes: { commands: Array<{ command: string }> };
};
const declared = pkg.contributes.commands.map((entry) => entry.command);
const table = Object.keys(COMMAND_COVERAGE);

describe("コマンドごとの区分の表", () => {
  test("package.json のコマンドが全部、表にある", () => {
    const missing = declared.filter((command) => !(command in COMMAND_COVERAGE));
    expect(
      missing,
      "src/core/commandCoverage.ts に区分を足してください（外部AIから届くか）"
    ).toEqual([]);
  });

  test("表に、package.json に無いコマンドが残っていない", () => {
    const stale = table.filter((command) => !declared.includes(command));
    expect(stale, "消したコマンドは表からも外してください").toEqual([]);
  });

  test("C4 には理由の種類があり、ほかの区分には無い", () => {
    for (const [command, entry] of Object.entries(COMMAND_COVERAGE)) {
      if (entry.class === "C4") {
        expect(entry.reason, command).toBeDefined();
      } else {
        expect(entry.reason, command).toBeUndefined();
      }
    }
  });

  test("novel.read で届くようにしたコマンドは A で、道が書いてある", () => {
    const viaRead = Object.entries(COMMAND_COVERAGE)
      .filter(([, entry]) => entry.via?.startsWith("novel.read"))
      .map(([command, entry]) => [command, entry.class]);
    expect(viaRead).toEqual([
      ["novelai.openSettingsPanel", "A"],
      ["novelai.showSettingsForTerm", "A"],
      ["novelai.openRelationGraph", "A"],
      ["novelai.openLocationSketch", "A"],
      ["novelai.openChronicle", "A"],
      ["novelai.openForeshadows", "A"],
      ["novelai.resumeWriting", "A"],
    ]);
  });

  test("run.request で届くようにしたコマンドには道が書いてあり、その機能を頼める", () => {
    const viaRun = Object.entries(COMMAND_COVERAGE)
      .filter(([, entry]) => entry.via?.startsWith("run.request"))
      .map(([command, entry]) => [command, entry.class, entry.via]);
    expect(viaRun).toEqual([
      ["novelai.testAI", "B", "run.request feature: testAI"],
      ["novelai.extractSettings", "A", "run.request feature: settings"],
      ["novelai.checkOpening", "A", "run.request feature: opening"],
      ["novelai.checkFactContradictions", "A", "run.request feature: factContradiction"],
    ]);
    // 道に書いた機能の名前が、run.request の受け付ける名前と食い違っていないこと
    for (const [, , via] of viaRun) {
      const feature = String(via).replace(/^run\.request feature: /u, "");
      expect(RUN_REQUESTABLE_FEATURES, String(via)).toContain(feature);
    }
  });

  test("C1（run.request に足せば届く）のまま、もう頼める機能が残っていない", () => {
    const stillC1 = Object.entries(COMMAND_COVERAGE)
      .filter(([, entry]) => entry.class === "C1" && entry.via?.startsWith("run.request"))
      .map(([command]) => command);
    expect(stillC1).toEqual([]);
  });

  test("道（via）に書いた道具が、MCP サーバーに登録されている", () => {
    const server = fs.readFileSync(nodePath.join(root, "src/mcp/server.ts"), "utf8");
    const tools = new Set(
      Object.values(COMMAND_COVERAGE)
        .map((entry) => entry.via?.split(" ")[0])
        .filter((name): name is string => Boolean(name))
    );
    for (const tool of tools) {
      expect(server, tool).toContain(`registerTool(\n  "${tool}"`);
    }
  });
});
