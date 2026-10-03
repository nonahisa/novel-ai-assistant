/**
 * コマンドパレット・選択の画面（QuickPick）・入力欄（InputBox）を押す（設計書6.113）。
 *
 * 作者が詳細メニューや右クリックから始めて、上に出る選択の画面で選び、
 * 入力欄に打って Enter で進む——その道を、そのまま押す。
 * **製品にテスト専用の口を足さずに済む**（キーを割り当てなくても、
 * パレットに出るコマンドは名前で呼べる）。
 *
 * VS Code 本体の DOM に頼るので、`workbenchDom.ts` と同じく**クラス名はここだけ**に
 * 書く（`workbenchDom.ts` は別の担当も触っているので、書き足さずに分けた）。
 * 確かめた版：1.138.0（2026-10-04）。
 */
import type { Page } from "playwright-core";
import { waitUntil } from "./wait";

const WIDGET = ".quick-input-widget";

/** 選択の画面・入力欄が出ているか */
export async function quickInputVisible(page: Page): Promise<boolean> {
  return page
    .locator(WIDGET)
    .first()
    .isVisible()
    .catch(() => false);
}

/** 選択の画面・入力欄の題（出ていなければ空文字） */
export async function quickInputTitle(page: Page): Promise<string> {
  if (!(await quickInputVisible(page))) return "";
  return ((await page.locator(`${WIDGET} .quick-input-title`).first().textContent().catch(() => "")) ?? "").trim();
}

/** 入力欄の下の説明・検証の文（出ていなければ空文字） */
export async function quickInputMessage(page: Page): Promise<string> {
  if (!(await quickInputVisible(page))) return "";
  return ((await page.locator(`${WIDGET} .quick-input-message`).first().textContent().catch(() => "")) ?? "").trim();
}

/** 選択の画面に並んでいる行の名前 */
export async function quickPickLabels(page: Page): Promise<string[]> {
  return page.evaluate((widget) => {
    const root = document.querySelector(widget);
    if (!root) return [];
    return Array.from(root.querySelectorAll(".monaco-list-row")).map((row) =>
      (row.querySelector(".label-name")?.textContent ?? row.getAttribute("aria-label") ?? "").trim()
    );
  }, WIDGET);
}

/** 題に `title` を含む選択の画面・入力欄が出るまで待つ */
export async function waitForQuickInput(page: Page, title: string, timeoutMs = 15_000): Promise<void> {
  await waitUntil(async () => (await quickInputTitle(page)).includes(title), `「${title}」の画面が出る`, timeoutMs).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（いまの題：「${await quickInputTitle(page)}」）`);
    }
  );
}

/**
 * 選択の画面で、名前に `label` を含む行を押す。
 * 複数選べる画面（canPickMany）では、押すと印が付く（付け外し）。
 */
export async function pickQuickItem(page: Page, label: string): Promise<void> {
  const row = page.locator(`${WIDGET} .monaco-list-row`, { hasText: label }).first();
  await row.waitFor({ state: "visible", timeout: 10_000 }).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（並び：${(await quickPickLabels(page)).join(" / ")}）`);
  });
  await row.click();
}

/**
 * 入力欄の字を入れ替えて（初期値は消す）、Enter で進む。
 *
 * **打つのは確定した字**（IME の変換は通らない。`keyboard.insertText`）
 */
export async function answerInput(page: Page, text: string): Promise<void> {
  await fillInput(page, text);
  await page.keyboard.press("Enter");
}

/** 入力欄の字を入れ替える（Enter は押さない。検証の文を読むときに使う） */
export async function fillInput(page: Page, text: string): Promise<void> {
  const input = page.locator(`${WIDGET} input`).first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.click();
  await page.keyboard.press("Control+KeyA");
  if (text === "") await page.keyboard.press("Delete");
  else await page.keyboard.insertText(text);
}

/** 選択の画面・入力欄が閉じるまで待つ */
export async function waitQuickInputClosed(page: Page, label: string): Promise<void> {
  await waitUntil(async () => !(await quickInputVisible(page)), label, 10_000);
}

/**
 * コマンドパレットから、題が `title` のコマンドを走らせる。
 *
 * 並ぶ行の名前は「分類: 題」なので、**題で終わる行**を押す（同じ語を含む別の
 * コマンドを取り違えない）。打った直後は前の一覧が残っていることがあるので、
 * 目当ての行が出るまで待つ。
 */
export async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press("Control+Shift+KeyP");
  const input = page.locator(`${WIDGET} input`).first();
  await input.waitFor({ state: "visible" });
  await page.keyboard.insertText(title);
  let index = -1;
  await waitUntil(
    async () => {
      const labels = await quickPickLabels(page);
      index = labels.findIndex((name) => name === title || name.endsWith(`: ${title}`));
      return index >= 0;
    },
    `コマンドパレットに「${title}」が出る`,
    10_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（並び：${(await quickPickLabels(page)).join(" / ")}）`);
  });
  await page.locator(`${WIDGET} .monaco-list-row`).nth(index).click();
}
