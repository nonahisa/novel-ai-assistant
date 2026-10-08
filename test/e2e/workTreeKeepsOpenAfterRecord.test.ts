/**
 * 作品一覧で作品を開いたまま変更を記録して、題の前の［記録待ち］の印が消えても、
 * 作品の行が畳まれずに開いたままでいる（画面の自動テスト、設計書5.5.17・6.113）。
 *
 * 実機確認リスト 0.89.20 の項目を機械へ移したもの。印を題の前に出すようにしたとき、行の id を
 * 「題＋印」で作ると、印が消えた瞬間に別の行になって畳まれてしまう。そこで id を作品で
 * 固定した（作品一覧の `workTree.ts`）。その固定が効いているかを、押して確かめる。
 *
 * 道筋は作者が押すのと同じ：作品を開く → 本文が変わって［記録待ち1］が付く →
 * 「GitHubと同期」→「変更を記録する」→ 説明を決めて記録 → 印が消える。
 * **送り先（リモート）の無い置き場にするので、GitHub は呼ばない。** 印の消え方は記録で決まり、
 * 送信は関わらない。
 */
import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { initRepoWithFirstCommit } from "./support/gitFixture";
import { runCommand, waitForQuickInput, waitQuickInputClosed } from "./support/quickInput";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { pickQuickPickRow, pressWorkbenchKey, quickPickTitle, waitForQuickPick } from "./support/workbenchDom";

const EPISODES = [
  { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
  { name: "第2話_つづき.txt", text: "二話の本文。\n" },
];

/** 作品の行（印が付くと名前の頭が変わるので、題を含む・開閉の印を持つ行で探す） */
function workRow(page: Page) {
  return page.locator(`.monaco-list-row[aria-expanded][aria-label*="${E2E_WORK_TITLE}"]`).first();
}

async function workRowLabel(page: Page): Promise<string> {
  return (await workRow(page).getAttribute("aria-label").catch(() => null)) ?? "";
}

async function episodeRowsShown(page: Page): Promise<number> {
  return page.locator(`.monaco-list-row[aria-label^="第1話"], .monaco-list-row[aria-label^="第2話"]`).count();
}

test("作品を開いたまま変更を記録して［記録待ち］の印が消えても、作品の行は畳まれずに開いたまま", async () => {
  await withVsCode(
    "記録しても畳まれない",
    EPISODES,
    async (session) => {
      const { page } = session;
      // 起こしたとき既に印が付いていると、行の名前が題で始まらない（showSidebar は使えない）ので、左の列を出すキーだけ押す
      await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");

      // 作品を開く
      await waitUntil(async () => (await workRow(page).count()) > 0, "作品の行が出る");
      if ((await workRow(page).getAttribute("aria-expanded")) !== "true") await workRow(page).click();
      await waitUntil(async () => (await workRow(page).getAttribute("aria-expanded")) === "true", "作品の行が開く");
      await waitUntil(async () => (await episodeRowsShown(page)) >= 2, "作品の下に話が並ぶ");

      // 本文が変わる（外から足す）→ 題の前に［記録待ち］が付く
      await appendFile(path.join(session.manuscriptFolder, "第1話_はじまり.txt"), "足した一行。\n", "utf8");
      await waitUntil(async () => (await workRowLabel(page)).includes("記録待ち"), "作品の行に［記録待ち］の印が付く", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（行：${await workRowLabel(page)}）`);
        }
      );
      expect(await workRow(page).getAttribute("aria-expanded"), "印が付いても開いたまま").toBe("true");

      // 記録する（GitHubと同期 → 変更を記録する → 説明はそのまま）
      await runCommand(page, "GitHubと同期");
      await waitUntil(
        async () => {
          const title = (await quickPickTitle(page)) ?? "";
          return title.includes("同期する作品を選択") || title.includes("のGitHub同期");
        },
        "同期の選ぶ画面が出る",
        15_000
      );
      if (((await quickPickTitle(page)) ?? "").includes("同期する作品を選択")) {
        await pickQuickPickRow(page, E2E_WORK_TITLE);
      }
      await waitForQuickPick(page, `${E2E_WORK_TITLE} のGitHub同期`);
      await pickQuickPickRow(page, "変更を記録する");
      await waitForQuickInput(page, "この記録に付ける説明");
      await page.keyboard.press("Enter");
      await waitQuickInputClosed(page, "記録の説明の入力欄が閉じる");

      // 印が消える
      await waitUntil(async () => !(await workRowLabel(page)).includes("記録待ち"), "記録したあと［記録待ち］の印が消える", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（行：${await workRowLabel(page)}）`);
        }
      );

      // 作品の行は畳まれずに開いたまま・話の行も並んだまま（しばらく見続ける）
      await holdsFor(
        async () => (await workRow(page).getAttribute("aria-expanded")) === "true" && (await episodeRowsShown(page)) >= 2,
        "印が消えても作品の行が開いたままで、話の行が並んでいる",
        3_000
      );
    },
    {
      ...SIDEBAR_LAUNCH,
      prepareWork: async ({ workFolder }) => {
        await initRepoWithFirstCommit(workFolder);
      },
    }
  );
}, 180_000);
