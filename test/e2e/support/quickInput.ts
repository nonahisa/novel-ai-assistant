/**
 * コマンドパレットと入力欄（InputBox）を押す（設計書6.113）。
 *
 * 作者が詳細メニューや右クリックから始めて、上に出る入力欄に打って Enter で進む——
 * その道を、そのまま押す。**製品にテスト専用の口を足さずに済む**（キーを割り当てなくても、
 * パレットに出るコマンドは名前で呼べる）。
 *
 * 選ぶ画面（QuickPick）の部品は `workbenchDom.ts`（`waitForQuickPick`・`pickQuickPickRow`・
 * `toggleQuickPickRow`・`acceptQuickPick`）にある。ここに置くのは、それで足りない
 * 「入力欄」と「題の一部で待つ」「パレットから走らせる」だけ。
 * VS Code 本体の DOM のクラス名に頼るので、`workbenchDom.ts` と同じく版で壊れたらここを直す。
 * 確かめた版：1.138.0（2026-10-04）。1.141.0 は**未実行**——頼っているクラス名
 * （`.quick-input-widget`・`.quick-input-list`・`.quick-input-message`・`.monaco-list-row`）が
 * 1.141.0 の配布物の `workbench.desktop.main.js` にも残っていることだけを確かめた（2026-10-10）。
 * 名前の拡張子を `.label-suffix` へ分ける 1.141.0 の変更はタブだけで、選ぶ画面の行には効かない。
 */
import type { Page } from "playwright-core";
import { waitUntil } from "./wait";
import { pressWorkbenchKey, quickPickRows, quickPickTitle } from "./workbenchDom";

const WIDGET = ".quick-input-widget";

/** 入力欄の下の説明・検証の文（出ていなければ空文字） */
export async function quickInputMessage(page: Page): Promise<string> {
  if ((await quickPickTitle(page)) === undefined) return "";
  return ((await page.locator(`${WIDGET} .quick-input-message`).first().textContent().catch(() => "")) ?? "").trim();
}

/**
 * 題に `title` を**含む**選ぶ画面・入力欄が出るまで待つ。
 *
 * `waitForQuickPick` は題の完全一致で待ち、行が出揃うまで待つ。入力欄（行が無い）と、
 * 題に作品名などが入って決め打ちしにくい画面は、こちらで待つ
 */
export async function waitForQuickInput(page: Page, title: string, timeoutMs = 15_000): Promise<void> {
  await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes(title), `「${title}」の画面が出る`, timeoutMs).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（いまの題：「${(await quickPickTitle(page)) ?? ""}」）`);
    }
  );
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

/** 選ぶ画面・入力欄が閉じるまで待つ */
export async function waitQuickInputClosed(page: Page, label: string): Promise<void> {
  await waitUntil(async () => (await quickPickTitle(page)) === undefined && !(await page.locator(`${WIDGET} input`).first().isVisible().catch(() => false)), label, 10_000);
}

/**
 * コマンドパレットから、題が `title` のコマンドを走らせる。
 *
 * 並ぶ行の名前は「分類: 題」なので、**題で終わる行**を押す（同じ語を含む別の
 * コマンドを取り違えない）。打った直後は前の一覧が残っていることがあるので、
 * 目当ての行が出るまで待つ。
 */
export async function runCommand(page: Page, title: string): Promise<void> {
  /*
    **パレットのキーは本体へ焦点を戻してから押し、出なければ押し直す。**
    パネル（WebView）を開いた直後は焦点が iframe の中にあり、素の `keyboard.press` は
    本体のキー割り当てに届かない。ノートPC（1.138.0・1.141.0 とも）では、設定資料・
    執筆統計の件でパレットの入力欄が出ないまま30秒待って落ちた（2026-10-10）。
    パネルが開き終わるまでの間に焦点が iframe へ移ることもあるので、1回で決めつけず3回まで
  */
  const input = page.locator(`${WIDGET} input`).first();
  for (let attempt = 1; ; attempt++) {
    await pressWorkbenchKey(page, "Control+Shift+KeyP");
    const shown = await input
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) break;
    if (attempt === 3) throw new Error(`コマンドパレットの入力欄が出ません（「${title}」を走らせようとして、3回押しました）`);
  }
  await page.keyboard.insertText(title);
  let index = -1;
  const labels = async () => (await quickPickRows(page)).map((row) => row.label);
  await waitUntil(
    async () => {
      index = (await labels()).findIndex((name) => name === title || name.endsWith(`: ${title}`));
      return index >= 0;
    },
    `コマンドパレットに「${title}」が出る`,
    10_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（並び：${(await labels()).join(" / ")}）`);
  });
  await page.locator(`${WIDGET} .quick-input-list .monaco-list-row`).nth(index).click();
}
