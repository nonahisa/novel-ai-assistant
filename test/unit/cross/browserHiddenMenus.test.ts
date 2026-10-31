import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { describe, expect, test } from "vitest";
import {
  browserHiddenCommands,
  PROCESSES_BLOCKED_CONTEXT,
} from "../../../src/core/processAvailability";
import {
  LM_AVAILABLE_CONTEXT,
  LM_REQUIRED_COMMANDS,
} from "../../../src/core/lmAvailability";
import { srcSource, srcSources } from "../support/srcSources";
import { blockAfter } from "../support/sourceBlock";

/**
 * 使えない機能をメニューから隠す（作者の裁定、2026-10-31「Bにしましょう」
 * 「ブラウザー版も隠す」。設計書5.8.5・5.9）。
 *
 * **一覧は src の1か所から取る**（`browserHiddenCommands`・`LM_REQUIRED_COMMANDS`）。
 * ここへ写すと、命令を足したときに package.json と一緒に直し忘れても通ってしまう。
 */

interface MenuEntry {
  command: string;
  when?: string;
}

const manifest = JSON.parse(
  readFileSync(nodePath.resolve(__dirname, "../../../package.json"), "utf8")
) as { contributes: { menus: Record<string, MenuEntry[]> } };
const menus = manifest.contributes.menus;

/**
 * 隠す印（`!novelai.processesBlocked`）を条件に含むか。`false` は誰にも出ないので隠れている。
 * `isWeb` では分けない（作者の裁定 2026-10-31「動くものは出す」。Codespaces では出す）
 */
const hidesOnWeb = (when: string | undefined): boolean =>
  when === "false" ||
  (when ?? "").split(/\s*(?:&&|\|\||\(|\))\s*/).includes(`!${PROCESSES_BLOCKED_CONTEXT}`);

test("isWeb では分けない（画面だけブラウザの所でも、動くものは出す）", () => {
  expect(JSON.stringify(manifest)).not.toMatch(/\bisWeb\b/);
});

const hidesWithoutLm = (when: string | undefined): boolean =>
  when === "false" || (when ?? "").includes(LM_AVAILABLE_CONTEXT);

describe("ブラウザ版で使えない命令は、どのメニューからも隠す", () => {
  const commands = browserHiddenCommands();

  test("一覧は空でない（取り出し方が壊れていない）", () => {
    expect(commands.length).toBeGreaterThan(10);
  });

  /*
    **コマンドパレットは項目が無いと出てしまう**（VS Code の既定）。
    `when` を見るだけでなく、項目が在ることから確かめる
  */
  for (const command of commands) {
    test(`${command}：コマンドパレットの項目があり、ブラウザ版では出ない`, () => {
      const entries = menus.commandPalette.filter((e) => e.command === command);
      expect(entries.length, command).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(hidesOnWeb(entry.when), `${command} の when: ${entry.when}`).toBe(true);
      }
    });
  }

  test("右クリック・ビューの見出しなど、ほかの出口にも隠す印がある", () => {
    const set = new Set(commands);
    const leaks: string[] = [];
    for (const [where, entries] of Object.entries(menus)) {
      if (where === "commandPalette") continue;
      for (const entry of entries) {
        if (set.has(entry.command) && !hidesOnWeb(entry.when)) {
          leaks.push(`${where} ${entry.command}（${entry.when ?? "条件なし"}）`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  test("同期（gitSync）は隠さない（ソース管理へ案内する。設計書5.8.9）", () => {
    expect(commands).not.toContain("novelai.gitSync");
    for (const entries of Object.values(menus)) {
      for (const entry of entries) {
        if (entry.command === "novelai.gitSync") {
          expect(entry.when ?? "").not.toContain(PROCESSES_BLOCKED_CONTEXT);
        }
      }
    }
  });
});

describe("VS Code のAIの口を使う命令は、口が働かないエディターで隠す", () => {
  for (const command of LM_REQUIRED_COMMANDS) {
    test(`${command}：すべての出口に ${LM_AVAILABLE_CONTEXT} の条件がある`, () => {
      const palette = menus.commandPalette.filter((e) => e.command === command);
      expect(palette.length, command).toBeGreaterThan(0);
      for (const [where, entries] of Object.entries(menus)) {
        for (const entry of entries) {
          if (entry.command !== command) continue;
          expect(hidesWithoutLm(entry.when), `${where} ${command}`).toBe(true);
        }
      }
    });
  }

  /*
    **口に触るファイルの顔ぶれを見張る。** いまは AI の接続先1つだけで、隠すのは
    選択肢の1行（`LM_REQUIRED_COMMANDS` は0件）。口を使う命令やファイルが
    増えたらここで落ち、一覧と package.json の `when` を見直すきっかけになる
  */
  test("vscode.lm に触るのは、VS Code に繋いであるAIの接続先だけ", () => {
    const users = srcSources()
      .filter((source) => /vscode\.lm\??\./.test(source.body))
      .map((source) => source.file)
      .sort();
    expect(users).toEqual(["ai/vscodeLmProvider.ts"]);
  });

  test("vscode.chat・MCP の登録の口は使っていない", () => {
    const users = srcSources()
      .filter((source) =>
        /vscode\.chat\b|registerMcpServerDefinitionProvider|lm\.registerTool/.test(
          source.body
        )
      )
      .map((source) => source.file);
    expect(users).toEqual([]);
  });
});

describe("口の確かめは、起動の時間に入れない（作者の前提、2026-10-31）", () => {
  const extension = srcSource("extension.ts");

  /*
    整備と同じ起こし役（`startWorkMaintenance`）に載せる。合図は作品一覧の初回描画で、
    来なければ上限（60秒）で起きる——サイドバーを開かない起動でも抜け落ちない
  */
  test("確かめは整備と同じ合図（初回描画か60秒の上限）で、待たずに起こす", () => {
    const body = blockAfter(extension, "const startWorkMaintenance = (", {
      where: "extension.ts",
    });
    expect(body).toContain("void lmGate.recheckInBackground()");
    const render = blockAfter(extension, "const noteFirstWorkListRender = (", {
      where: "extension.ts",
    });
    expect(render).toContain("maintenanceTrigger.signal()");
  });

  test("activate のどこでも、確かめを await していない", () => {
    expect(extension).not.toMatch(/await\s+lmGate\./);
    expect(extension).not.toMatch(/await\s+probeVsCodeLm\b/);
    // 起こすのは1か所だけ（起動の道にもう1か所足されていない）
    expect(extension.match(/lmGate\.recheckInBackground\(/g) ?? []).toHaveLength(1);
  });

  test("隠す印は activate の最初のほうで、待たずに立てる", () => {
    const start = extension.indexOf("export async function activate(");
    const at = extension.indexOf("PROCESSES_BLOCKED_CONTEXT,", start);
    expect(start).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(start);
    const before = extension.slice(start, at);
    expect(before).toMatch(/void vscode\.commands\.executeCommand\(\s*"setContext",\s*$/);
    // 最初の await より前（起動の待ちに入らない）
    expect(before).not.toMatch(/\bawait\b/);
  });
});
