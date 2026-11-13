/**
 * ［入力］→「テキストファイルから」で［上書きする］を選んだあと、タイムラインの欄に
 * 「書き換える前の控え」の行が出て、押すと前の本文の写しが開くか
 * （画面の自動テスト、設計書6.25.13・6.119・6.113。実機確認リスト 0.147.0 の「［上書きする］…戻せるか」の残り）。
 *
 * 見張ること：
 * 1. 上書きしたあと、欄（Timeline）に「書き換える前の控え」の行が出る
 * 2. その行を押すと、控え（`.novelai-recovery`）の写しが開き、**書き換える前の本文**が読める
 * 3. 話の本文は、写しを開いただけでは触れない（取り込んだ文のまま）
 *
 * **見ていないこと**：写しから原稿エディターへ貼り戻す操作そのもの（製品の行の説明は
 * 「押すと写しを開きます。本文には触れません」。戻す＝作者が写しから貼り戻す）。
 *
 * **Timeline の口は VS Code 1.145 で正式になった。** `NOVELAI_E2E_VSCODE=1.145.0` で走らせる
 * （1.145 より前では何も見ずに通す。`episodeTimelineDecisions` と同じ）。**AI は呼ばない。**
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { TEXT_DIALOG_TITLE, launchWith, manuscriptText, pickFileInDialog, sourcePathOf, waitDialogWith, waitWithContext } from "./support/importFlow";
import { clickToolButton, openEpisode } from "./support/manuscriptFrame";
import { waitForNotice } from "./support/noticeRecord";
import { E2E_VSCODE_VERSION, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pressDialogButton, pressWorkbenchKey } from "./support/workbenchDom";

const FILLED = ["一", "二", "三"].map((kanji, index) => ({ name: `00${index + 1}.txt`, text: `　${kanji}話の本文。\n` }));
const IMPORTED = "　置き換えた本文。\n";

const TIMELINE_KEY = "ctrl+alt+shift+t";
const TIMELINE_PRESS = "Control+Alt+Shift+KeyT";
const RECOVERY_ROW = "書き換える前の控え";

function versionAtLeast(actual: string, wanted: readonly number[]): boolean {
  const parts = actual.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < wanted.length; index += 1) {
    const a = parts[index] ?? 0;
    const b = wanted[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function timelinePane(page: Page) {
  return page.locator(".pane", { has: page.locator(".pane-header", { hasText: /Timeline|タイムライン/ }) }).first();
}

async function timelineRows(page: Page): Promise<string[]> {
  const pane = timelinePane(page);
  if ((await pane.count()) === 0) return [];
  return (await pane.locator(".monaco-list-row").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
}

/** 前に出ている通常のエディター（Monaco）の字。控えの写しはここに開く */
async function monacoText(page: Page): Promise<string> {
  return (await page.locator(".editor-instance .monaco-editor .view-lines").first().innerText().catch(() => "")).replace(/ /g, " ");
}

test.skipIf(!versionAtLeast(E2E_VSCODE_VERSION, [1, 145]))(
  "［上書きする］のあと、タイムラインの欄に「書き換える前の控え」が出て、押すと書き換える前の本文の写しが開く（話の本文は取り込んだ文のまま）",
  async () => {
    await withVsCode(
      "上書き後のタイムラインの控え",
      FILLED,
      async (session) => {
        const { page } = session;
        const frame = await openEpisode(page, "003.txt", "三話の本文");
        const since = Date.now();
        await clickToolButton(frame, "importText");
        await pickFileInDialog(page, TEXT_DIALOG_TITLE, sourcePathOf(session, "置き換え.txt"));
        await waitDialogWith(session, "いまの本文 6字が消え", "上書きで消える字数を書いた確認の窓が出る");
        await pressDialogButton(page, "上書きする");
        await waitWithContext(session, async () => (await manuscriptText(session, "003.txt")) === IMPORTED, "003.txt の本文が取り込んだ文に変わる", 30_000, since);
        await waitForNotice(session, (message) => message.includes("書き換える前の本文は控え"), "控えの場所を書いた知らせ", { since });

        // 欄を出す（原稿のタブは前に出ている）。控えの行は、欄が話を読み直したときに並ぶ
        await pressWorkbenchKey(page, TIMELINE_PRESS);
        await waitUntil(async () => (await timelineRows(page)).some((row) => row.includes(RECOVERY_ROW)), `欄に「${RECOVERY_ROW}」の行が出る`, 20_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（欄の行：${JSON.stringify(await timelineRows(page))}）`);
          }
        );

        // 行を押すと、控えの写しが開く（本文は書き換える前のもの）
        await timelinePane(page).locator(".monaco-list-row", { hasText: RECOVERY_ROW }).first().click();
        let shown = "";
        await waitUntil(async () => (shown = await monacoText(page)).includes("三話の本文"), "控えの写しが開き、書き換える前の本文が読める", 15_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（前のエディターの字：${JSON.stringify(shown)}）`);
          }
        );
        expect(shown, "写しは取り込んだ文でなく、前の本文").not.toContain("置き換えた本文");

        // 写しを開いただけでは、話の本文は触れない
        const body = (await readFile(path.join(session.manuscriptFolder, "003.txt"), "utf8")).replace(/\r\n/g, "\n");
        expect(body).toBe(IMPORTED);
      },
      {
        ...launchWith({ "置き換え.txt": IMPORTED }, undefined, { "novelai.timeline.show": true }),
        keybindings: [{ key: TIMELINE_KEY, command: "timeline.focus" }],
      }
    );
  },
  240_000
);
