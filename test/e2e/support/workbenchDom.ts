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

/** 列ごとに、前に出ているタブの名前（その列にタブが無ければ空文字）。左の列から順に */
export async function activeTabNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".editor-group-container")).map((group) => {
      const tab = group.querySelector(".tabs-container .tab.active");
      if (!tab) return "";
      const name = tab.querySelector(".label-name")?.textContent;
      if (name) return name.trim();
      return (tab.getAttribute("aria-label") ?? "").split(",")[0].trim();
    })
  );
}

/** その名前のタブが「未保存」の印（●）を付けているか */
export async function tabIsDirty(page: Page, name: string): Promise<boolean> {
  return page.evaluate(
    (wanted) =>
      Array.from(document.querySelectorAll(".tabs-container .tab.dirty")).some(
        (tab) => (tab.querySelector(".label-name")?.textContent ?? "").trim() === wanted
      ),
    name
  );
}

/** 焦点のある列（グループ）の番号。左の列から 0, 1, … 。分からなければ -1 */
export async function activeGroupIndex(page: Page): Promise<number> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".editor-group-container")).findIndex((group) =>
      group.classList.contains("active")
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
 * 素のテキストエディター（Monaco）の、前に出ている1枚に見えている行の字。
 * 見えていなければ空文字
 */
export async function textEditorVisibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editors = Array.from(document.querySelectorAll(".editor-group-container.active .monaco-editor .view-lines"));
    return editors.map((lines) => (lines as HTMLElement).innerText).join("\n");
  });
}

/** `groupIndex` 番目の列（左から 0）の、素のテキストエディターに見えている行の字 */
export async function textEditorVisibleTextIn(page: Page, groupIndex: number): Promise<string> {
  return page.evaluate((index) => {
    const group = document.querySelectorAll(".editor-group-container")[index];
    if (!group) return "";
    return Array.from(group.querySelectorAll(".monaco-editor .view-lines"))
      .map((lines) => (lines as HTMLElement).innerText)
      .join("\n");
  }, groupIndex);
}

/** 素のテキストエディターの本文を押して、焦点を移す */
export async function focusTextEditor(page: Page): Promise<void> {
  await page.locator(".editor-group-container.active .monaco-editor .view-lines").first().click();
}

/**
 * 素のテキストエディターのカーソルの行と桁（下のステータスバーの「Ln 3, Col 1」）。
 * 出ていなければ undefined。**英語の表示**（言語パックを入れていない）を前提に読む
 */
export async function textEditorCursor(page: Page): Promise<{ line: number; column: number } | undefined> {
  const text = await page
    .locator('[id="status.editor.selection"]')
    .first()
    .innerText()
    .catch(() => "");
  const match = /Ln (\d+), Col (\d+)/.exec(text);
  return match ? { line: Number(match[1]), column: Number(match[2]) } : undefined;
}

/** 問題の見出し（F8 の「次の問題」で本文の中に開く枠）が出ているか */
export async function markerWidgetShown(page: Page): Promise<boolean> {
  return (await page.locator(".monaco-editor .marker-widget").count()) > 0;
}

/**
 * コマンドパレット（Ctrl+Shift+P）で `query` を探し、並んだ行の名前を返して閉じる。
 *
 * 行の名前は「分類: 題」（この拡張機能なら「小説執筆: …」）。**候補が出揃うのを
 * 待つ**——打った直後は前の一覧が残っていることがあるので、数が落ち着くまで見る
 */
export async function commandPaletteLabels(page: Page, query: string): Promise<string[]> {
  await page.keyboard.press("Control+Shift+KeyP");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible" });
  await page.keyboard.insertText(query);
  const read = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".quick-input-widget .monaco-list-row")).map((row) =>
        (row.querySelector(".label-name")?.textContent ?? row.getAttribute("aria-label") ?? "").trim()
      )
    );
  let labels: string[] = [];
  let stable = 0;
  await waitUntil(
    async () => {
      const now = await read();
      stable = now.length > 0 && JSON.stringify(now) === JSON.stringify(labels) ? stable + 1 : 0;
      labels = now;
      return stable >= 3;
    },
    `コマンドパレットで「${query}」の候補が出揃う`,
    10_000
  );
  await page.keyboard.press("Escape");
  await input.waitFor({ state: "hidden" });
  return labels;
}

/**
 * **VS Code 本体向けのキー**（使い捨ての keybindings.json に書いた Ctrl+Alt+Shift+F<n> など）を、
 * 本体に焦点を戻してから押す。
 *
 * WebView（校正・メモパネル・人物相関図など）を開くと、焦点が WebView の中へ移る。そのまま
 * Playwright でキーを送ると、**本体のキー割り当てに届かない**（Keyboard Shortcuts
 * Troubleshooting のログに「Received keydown event」の行が1行も出ない。`document.hasFocus()` は偽か、
 * 焦点が iframe）。2026-10-03、ノートPCで `commandNames`／`memoFixOneStep` が落ちて分かった
 * （同じテストが母艦では通る。届くかどうかは WebView の読み込みの進み方しだい）。
 *
 * `window.focus()` は**画面の中だけの操作**で、OS の前面は取らない（`vscodeApp.ts` の
 * `keepOutOfTheWay` の決まりを崩さない。`page.bringToFront()` は使わない）。
 */
export async function pressWorkbenchKey(page: Page, chord: string): Promise<void> {
  await page.evaluate(() => {
    // iframe（WebView）に焦点があれば外す。焦点が本体の入力欄などにあるときは触らない
    const active = document.activeElement;
    if (active && active.tagName === "IFRAME") (active as HTMLElement).blur();
    window.focus();
  });
  await page.keyboard.press(chord);
}

/**
 * キーボード ショートカットの画面で `query` を探し、並んだ行の
 * 「コマンドの名前」と「キー」を返す（画面は開いたまま）。
 *
 * 開くのは `OPEN_KEYBINDINGS_KEY`（使い捨ての keybindings.json に足す）。
 * **Ctrl+K Ctrl+S の2段のキーは、焦点が WebView（パネル）の中にあると届かなかった**
 * （1段のキーでも同じ。`pressWorkbenchKey` で本体へ焦点を戻してから押す）
 */
export async function keybindingsEditorRows(page: Page, query: string): Promise<Array<{ command: string; keys: string }>> {
  const search = page
    .locator(".keybindings-editor .keybindings-header input")
    .first();
  // 開いていなければ開く（2回目からは探す語だけ入れ替える）
  if ((await search.count()) === 0 || !(await search.isVisible())) {
    await pressWorkbenchKey(page, OPEN_KEYBINDINGS_PRESS);
  }
  await search.waitFor({ state: "visible", timeout: 10_000 });
  await search.click();
  await page.keyboard.press("Control+KeyA");
  await page.keyboard.insertText(query);
  const read = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".keybindings-editor .monaco-list-row")).map((row) => ({
        // 名前の欄は幅で「…」に切れて見えるが、字そのものは全部入っている
        command: (row.querySelector(".command-label")?.textContent ?? "").trim(),
        // 「Ctrl+/」「Shift+F8」の形（キーの札と「+」をつないだ字）
        keys: (row.querySelector(".monaco-keybinding")?.textContent ?? "").trim(),
      }))
    );
  let rows: Array<{ command: string; keys: string }> = [];
  let stable = 0;
  await waitUntil(
    async () => {
      const now = await read();
      stable = now.length > 0 && JSON.stringify(now) === JSON.stringify(rows) ? stable + 1 : 0;
      rows = now;
      // 探す語を入れ替えたあと、絞り込みは少し遅れて効くので、長めに落ち着きを見る
      return stable >= 8;
    },
    `キーボード ショートカットで「${query}」の行が出揃う`,
    10_000
  );
  return rows;
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

/** 確認の画面のボタンを、名前で押す */
export async function pressDialogButton(page: Page, label: string): Promise<void> {
  await page.locator(".monaco-dialog-box .monaco-button", { hasText: label }).first().click();
  await page.locator(".monaco-dialog-box").waitFor({ state: "detached", timeout: 5_000 });
}

/** 確認の画面を Esc で閉じる（何も選ばない） */
export async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(".monaco-dialog-box").waitFor({ state: "detached", timeout: 5_000 });
}

/** キーボード ショートカットの画面を開くキー。使う件は `LaunchOptions.keybindings` へ足す */
export const OPEN_KEYBINDINGS_KEY = "ctrl+alt+shift+f4";
const OPEN_KEYBINDINGS_PRESS = "Control+Alt+Shift+F4";
export const OPEN_KEYBINDINGS_BINDING = { key: OPEN_KEYBINDINGS_KEY, command: "workbench.action.openGlobalKeybindings" };

/** 知らせを閉じるキー（VS Code での書き方）。keybindings.json へ書く */
export const CLEAR_NOTIFICATIONS_KEY = "ctrl+alt+shift+f11";
const CLEAR_NOTIFICATIONS_PRESS = "Control+Alt+Shift+F11";
