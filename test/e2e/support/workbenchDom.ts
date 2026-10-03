/**
 * VS Code 本体の画面（ワークベンチ）の DOM に頼る部分を、**ここ1か所に集める**（設計書6.113）。
 *
 * タブの列・クイックオープン・知らせのクラス名は VS Code の中の事情で、
 * 版が上がると変わることがある。壊れたらここだけ直せばよいように、
 * テストの本体からはクラス名を書かない。
 *
 * 確かめた版：1.138.0（2026-10-03）。
 */
import type { Page } from "playwright-core";
import { waitUntil } from "./wait";

/** エディターの列（グループ）ごとの、タブの名前。左の列から順に */
export async function editorGroupTabs(page: Page): Promise<string[][]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".editor-group-container")).map((group) =>
      Array.from(group.querySelectorAll(".tabs-container .tab")).map((tab) => {
        // 名前の部分（`label-name`）を取る。無い版では読み上げ用の名前の頭を使う
        const name = tab.querySelector(".label-name")?.textContent;
        if (name) return name.trim();
        return (tab.getAttribute("aria-label") ?? "").split(",")[0].trim();
      })
    )
  );
}

/**
 * クイックオープン（Ctrl+P）でファイルを開く。
 *
 * 候補に名前が出るまで待ってから Enter を押す（出る前に押すと、
 * 空の候補で閉じて何も開かない）。
 */
export async function quickOpen(page: Page, fileName: string): Promise<void> {
  await page.keyboard.press("Control+KeyP");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible" });
  await page.keyboard.insertText(fileName);
  await page
    .locator(".quick-input-widget .monaco-list-row", { hasText: fileName })
    .first()
    .waitFor({ state: "visible" });
  await page.keyboard.press("Enter");
  await input.waitFor({ state: "hidden" });
}

/**
 * 右下の知らせを閉じる。
 *
 * 作品を登録すると「登録しました」の知らせが出て、右下のボタンや本文の端を塞ぐ。
 * 閉じるのは使い捨ての keybindings.json に書いたキー（`notifications.clearAll`）。
 */
export async function clearNotifications(page: Page): Promise<void> {
  await page.keyboard.press(CLEAR_NOTIFICATIONS_PRESS);
  await waitUntil(
    async () => (await page.locator(".notification-toast").count()) === 0,
    "知らせが閉じる",
    5_000
  ).catch(() => undefined);
}

/**
 * 確認の画面（モーダル）に出ている文。出ていなければ undefined。
 *
 * **確認の画面は VS Code の中に描かせる**（設定 `window.dialogStyle: "custom"`）。
 * 既定の Windows では OS のダイアログになり、Playwright から読めないうえ、
 * 作者の画面の前面に出てしまう。
 */
export async function dialogText(page: Page): Promise<string | undefined> {
  const dialog = page.locator(".monaco-dialog-box");
  if ((await dialog.count()) === 0) return undefined;
  return dialog.first().innerText();
}

/** 確認の画面を Esc で閉じる（何も選ばない） */
export async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(".monaco-dialog-box").waitFor({ state: "detached", timeout: 5_000 });
}

/** 知らせを閉じるキー（VS Code での書き方）。keybindings.json へ書く */
export const CLEAR_NOTIFICATIONS_KEY = "ctrl+alt+shift+f11";
const CLEAR_NOTIFICATIONS_PRESS = "Control+Alt+Shift+F11";
