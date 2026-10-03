/**
 * 左の「統合小説執筆環境」の列（作品一覧・簡単ステップメニュー・詳細メニュー）を
 * 押す（設計書6.113）。
 *
 * - 行は**読み上げ用の名前（aria-label）の頭で探す**。名前と添え書き（「3ファイル /
 *   12字」）は画面では別の字の並びに分かれていて、見えている字の連なりでは探しにくい
 * - **右クリックの品書きを読めるように、品書きを VS Code の中に描かせる**
 *   （`window.menuStyle: "custom"`。`SIDEBAR_LAUNCH` に入れてある）。既定の Windows では
 *   OS のメニューになり、Playwright から読めないうえ、作者の画面の前面に出る
 *
 * VS Code 本体の DOM に頼るのは `quickInput.ts` と同じく、ここに閉じ込める。
 * 確かめた版：1.138.0（2026-10-04）。
 */
import type { Locator, Page } from "playwright-core";
import { waitUntil } from "./wait";
import { pressWorkbenchKey } from "./workbenchDom";

/**
 * 左の列を出すキー（使い捨ての keybindings.json に書く）。F1〜F12 は埋まったので、
 * 文字キーとの組にする（製品の package.json にも VS Code の既定にも無い組）
 */
export const SHOW_SIDEBAR_KEY = "ctrl+alt+shift+j";
const SHOW_SIDEBAR_PRESS = "Control+Alt+Shift+KeyJ";

/** 左の列を使う件が `withVsCode` の起こし方へ渡すもの */
export const SIDEBAR_LAUNCH = {
  settings: { "window.menuStyle": "custom" } as Record<string, unknown>,
  keybindings: [{ key: SHOW_SIDEBAR_KEY, command: "workbench.view.extension.novelai" }] as Record<string, unknown>[],
};

/** 左の列（統合小説執筆環境）を出し、作品一覧に作品の行が出るまで待つ */
export async function showSidebar(page: Page, workTitle: string): Promise<void> {
  // WebView を開いたあとでも本体のキー割り当てに届くよう、焦点を本体へ戻してから押す
  await pressWorkbenchKey(page, SHOW_SIDEBAR_PRESS);
  await waitUntil(async () => (await treeRow(page, workTitle).count()) > 0, `作品一覧に「${workTitle}」の行が出る`);
}

/** 名前（aria-label）が `head` で始まる行 */
export function treeRow(page: Page, head: string): Locator {
  return page.locator(`.monaco-list-row[aria-label^="${head.replace(/"/g, '\\"')}"]`).first();
}

/** 名前（aria-label）が `head` で始まる行の、読み上げ用の名前全体（添え書きを含む） */
export async function treeRowLabel(page: Page, head: string): Promise<string> {
  const row = treeRow(page, head);
  if ((await row.count()) === 0) return "";
  return (await row.getAttribute("aria-label")) ?? "";
}

/** 左の列に並んでいる行の名前（上から） */
export async function treeRowLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".monaco-list-row")).map((row) => row.getAttribute("aria-label") ?? "")
  );
}

/** 作品の行を開く（畳まれていれば押して開く） */
export async function expandTreeRow(page: Page, head: string): Promise<void> {
  const row = treeRow(page, head);
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await row.click();
  await waitUntil(async () => (await row.getAttribute("aria-expanded")) === "true", `「${head}」の行が開く`);
}

/** 右クリックの品書き（VS Code の中に描いたもの）の名前 */
export async function contextMenuLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".context-view .action-label"))
      .map((item) => (item.textContent ?? "").trim())
      .filter((text) => text !== "")
  );
}

/** 行を右クリックし、品書きの `item` を押す */
export async function treeContextMenu(page: Page, head: string, item: string): Promise<void> {
  await treeRow(page, head).click({ button: "right" });
  await waitUntil(async () => (await contextMenuLabels(page)).includes(item), `右クリックの品書きに「${item}」が出る`).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（品書き：${(await contextMenuLabels(page)).join(" / ")}）`);
    }
  );
  await page.locator(".context-view .action-label", { hasText: item }).first().click();
  /*
    **押しても品書きが閉じないことがある**（2026-10-04、作品の行の右クリックで踏んだ。
    行は選ばれた色になるが、押したことにならない）。押した行には焦点が載っているので、
    閉じていなければ Enter で選び直す
  */
  const closed = async () => (await page.locator(".context-view .monaco-menu").count()) === 0;
  await waitUntil(closed, "右クリックの品書きが閉じる", 2_000).catch(async () => {
    await page.keyboard.press("Enter");
    await waitUntil(closed, `右クリックの品書きで「${item}」を選んで閉じる`, 5_000);
  });
}
