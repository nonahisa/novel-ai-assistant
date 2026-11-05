/**
 * タイムラインの欄が、原稿エディター（自前の編集画面、設計書6.25）で開いた話を追うか（画面の自動テスト、
 * 設計書6.119・6.113。0.130.0 で作ったときに未確認として残した点。母艦経由の作者の裁定 2026-11-06）。
 *
 * 見張ること：
 * - 設定 `novelai.timeline.show` を入れた状態で、原稿エディターで第1話を開き、タイムラインの欄を出すと、
 *   第1話への編集者の提案が項目として出る
 * - 原稿エディターで第2話へ切り替えると、第1話の提案は消える（欄が開いている話を追っている）
 *
 * **Timeline の口は VS Code 1.145 で正式になった。** 既定の試験の版（1.141.0）には口が無く、欄に何も出ない。
 * 走らせるときは `NOVELAI_E2E_VSCODE=1.145.0` を付ける。1.145 より前で走らせたときは、何も見ずに通す。
 * **GitHub・AI は呼ばない。**
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { openEpisode } from "./support/manuscriptFrame";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { E2E_VSCODE_VERSION, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pressWorkbenchKey } from "./support/workbenchDom";

const FIRST = "001_駅.txt";
const SECOND = "002_坂.txt";
const TIMELINE_KEY = "ctrl+alt+shift+t";
const PROPOSAL_TARGET = "雨の音";

function versionAtLeast(actual: string, wanted: readonly number[]): boolean {
  const parts = actual.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < wanted.length; index += 1) {
    const a = parts[index] ?? 0;
    const b = wanted[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** タイムラインの欄の行の字（英語の画面でも日本語の画面でも拾う） */
async function timelineRows(page: Page): Promise<string[]> {
  const pane = page.locator(".pane", { has: page.locator(".pane-header", { hasText: /Timeline|タイムライン/ }) }).first();
  if ((await pane.count()) === 0) return [];
  return (await pane.locator(".monaco-list-row").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
}

test.skipIf(!versionAtLeast(E2E_VSCODE_VERSION, [1, 145]))(
  "タイムラインの欄は、原稿エディターで開いた話の記録を出し、別の話へ切り替えると追って替わる",
  async () => {
    await withVsCode(
      "タイムラインが原稿エディターを追う",
      [
        { name: FIRST, text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n" },
        { name: SECOND, text: "　坂の上で、灯がひとつ揺れていた。\n" },
      ],
      async (session) => {
        const { page, workFolder } = session;
        // 第1話への編集者の提案を1件置く（提案の台帳の形は `core/proposalStore.ts`）
        const ledger = path.join(workFolder, ".aiwriter", "proposals", "proposals.jsonl");
        await mkdir(path.dirname(ledger), { recursive: true });
        await writeFile(
          ledger,
          `${JSON.stringify({
            kind: "proposal",
            id: "p-e2e-1",
            time: "2026-11-06T01:00:00.000Z",
            proposer: "編集者",
            file: `本文/${FIRST}`,
            line: 1,
            original: "　終電を逃した駅のホームに、雨の音だけが残っていた。",
            target: PROPOSAL_TARGET,
            suggestion: "雨音",
            reason: "音の字の重なり",
            category: "",
          })}\n`,
          "utf8"
        );

        await openEpisode(page, FIRST, "雨の音");
        await pressWorkbenchKey(page, "Control+Alt+Shift+KeyT");
        let rows: string[] = [];
        await waitUntil(
          async () => {
            rows = await timelineRows(page);
            return rows.some((row) => row.includes("編集者の提案"));
          },
          "原稿エディターで第1話を開くと、タイムラインの欄に第1話への編集者の提案が出る",
          20_000
        ).catch((error: unknown) => {
          throw new Error(`${String(error)}（欄の行：${JSON.stringify(rows)}）`);
        });

        // 第2話へ切り替えると、第1話の提案は欄から消える
        await openEpisode(page, SECOND, "坂の上");
        await pressWorkbenchKey(page, "Control+Alt+Shift+KeyT");
        await waitUntil(
          async () => {
            rows = await timelineRows(page);
            return !rows.some((row) => row.includes("編集者の提案"));
          },
          "原稿エディターで第2話へ切り替えると、第1話の提案が欄から消える",
          20_000
        ).catch((error: unknown) => {
          throw new Error(`${String(error)}（欄の行：${JSON.stringify(rows)}）`);
        });
        expect(rows.some((row) => row.includes("編集者の提案"))).toBe(false);
      },
      {
        settings: { ...SIDEBAR_LAUNCH.settings, "novelai.timeline.show": true },
        keybindings: [...SIDEBAR_LAUNCH.keybindings, { key: TIMELINE_KEY, command: "timeline.focus" }],
      }
    );
  },
  240_000
);
