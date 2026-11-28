/**
 * 障害報告用の記録を書き出したあとの［Discord で報告する］（画面の自動テスト。設計書8.5.1・6.113。1.1.0）。
 * 作者の頼み 2026-11-28「貼るところまでやって欲しい」。
 *
 * **外のブラウザは開かせない。** 製品はリンクを `vscode.env.openExternal` で開く。テスト用の VS Code の
 * 本体側（Electron の主プロセス）で `shell.openExternal` を、開く URL を控えるだけの関数に替える
 * （postingKitSteps と同じ）。VS Code 自身の「外のサイトを開きますか」の窓は［Open］で越える。
 * クリップボードは本物の OS のものを通る。走らせたあと前の中身へ戻す。AI は呼ばない。
 *
 * 見張るのは次のとおり：
 * - 書き出したあとの案内のボタンが［Discord で報告する］［要約をコピー］［ファイルの場所を開く］の順に並ぶ
 * - ［Discord で報告する］を押すと、クリップボードに記録ファイルの完全な場所が入り（そのファイルが実在し、
 *   中に「# 要約」がある）、#不具合報告 のリンクを開こうとし、手順の窓（/不具合を報告・「添付」・貼るキー）が出る
 * - 手順の窓の［サーバーに参加する］で招待のリンクを開こうとし、窓は出直す
 * - ［場所をもう一度写す］で、ほかの物に替わったクリップボードが記録ファイルの場所に戻る
 * - 窓を閉じると、書き出したあとの案内がもう一度出る
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import {
  BUG_REPORT_CHANNEL_URL,
  COMMUNITY_DISCORD_URL,
  COPY_REPORT_PATH_AGAIN_LABEL,
  JOIN_COMMUNITY_LABEL,
  REPORT_ON_DISCORD_LABEL,
} from "../../src/core/community";
import { runCommand } from "./support/quickInput";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { dialogText, notificationTexts, pickQuickPickRow, pressDialogButton, quickPickRows, quickPickTitle } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n";
const STEPS_MESSAGE = "記録ファイルの場所を写しました";

/** 外のブラウザを開かせず、開こうとした URL だけ控える（本体側の `shell.openExternal` を替える） */
async function blockBrowser(session: E2ESession): Promise<void> {
  await session.app.evaluate(({ shell }) => {
    const target = globalThis as unknown as { __e2eOpened?: string[] };
    target.__e2eOpened = [];
    (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => {
      target.__e2eOpened?.push(url);
    };
  });
}

async function openedUrls(session: E2ESession): Promise<string[]> {
  return session.app.evaluate(() => (globalThis as unknown as { __e2eOpened?: string[] }).__e2eOpened ?? []);
}

async function clipboardText(session: E2ESession): Promise<string> {
  return session.app.evaluate(({ clipboard }) => clipboard.readText());
}

/** 書き出したあとの案内（右下の知らせ）のボタンの名前を、並んでいる順に */
async function doneButtons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const toast = Array.from(document.querySelectorAll(".notification-toast")).find((element) =>
      (element.textContent ?? "").includes("障害報告用の記録を書き出しました")
    );
    return toast ? Array.from(toast.querySelectorAll(".monaco-button")).map((button) => (button.textContent ?? "").trim()) : [];
  });
}

async function waitDoneButtons(page: Page, what: string): Promise<string[]> {
  let buttons: string[] = [];
  await waitUntil(async () => (buttons = await doneButtons(page)).length > 0, what, 20_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの知らせ：${JSON.stringify(await notificationTexts(page))}）`);
  });
  return buttons;
}

/**
 * 手順の窓が出るまで待つ。途中で VS Code 自身の「外のサイトを開きますか」が出たら［Open］で越える
 * （本物のブラウザは起きない）。窓の字を返す
 */
async function waitStepsDialog(page: Page, what: string): Promise<string> {
  let text = "";
  await waitUntil(
    async () => {
      text = (await dialogText(page)) ?? "";
      if (text.includes("open the external website")) {
        await pressDialogButton(page, "Open").catch(() => undefined);
        return false;
      }
      return text.includes(STEPS_MESSAGE);
    },
    what,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}／知らせ：${JSON.stringify(await notificationTexts(page))}）`);
  });
  return text;
}

/** 窓が閉じるまで待つ（押したボタンが効いたことを、次の窓と取り違えないため） */
async function waitDialogClosed(page: Page, what: string): Promise<void> {
  await waitUntil(async () => (await dialogText(page)) === undefined, what, 10_000);
}

test("障害報告用の記録：［Discord で報告する］で記録ファイルの場所を写し、#不具合報告 を開こうとして手順の窓を出す", async () => {
  await withVsCode(
    "障害報告をDiscordで",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const before = await clipboardText(session).catch(() => "");
      try {
        await blockBrowser(session);
        await runCommand(page, "障害報告用の記録を書き出す");
        // 作品が決まっていなければ選ぶ画面が出る。範囲は既定（直近24時間）のまま進む
        await waitUntil(
          async () => {
            const title = (await quickPickTitle(page)) ?? "";
            if (title.includes("どの作品の記録")) {
              const rows = await quickPickRows(page);
              const work = rows.find((row) => row.label !== "作品を選ばない" && row.label !== "キャンセル");
              if (work) await pickQuickPickRow(page, work.label);
              return false;
            }
            return title.includes("どこまでさかのぼるか");
          },
          "さかのぼる範囲の選ぶ画面が出る",
          30_000
        );
        await page.keyboard.press("Enter");
        await waitUntil(async () => (await quickPickRows(page)).some((row) => row.label === "書き出す"), "書き出す前の確認が出る", 30_000);
        await pickQuickPickRow(page, "書き出す");

        // ボタンは報告へ進む順に並ぶ（新しい道が先頭。添付しないで貼る道・ファイルの場所があと）
        expect(await waitDoneButtons(page, "書き出したあとの案内が出る")).toEqual([REPORT_ON_DISCORD_LABEL, "要約をコピー", "ファイルの場所を開く"]);

        await page.locator(".notification-toast .monaco-button", { hasText: REPORT_ON_DISCORD_LABEL }).first().click();
        const steps = await waitStepsDialog(page, "［Discord で報告する］のあと、手順の窓が出る");
        expect(steps).toContain("/不具合を報告");
        expect(steps).toContain("「添付」");
        expect(steps).toContain(process.platform === "darwin" ? "⇧⌘G" : process.platform === "win32" ? "Ctrl+V" : "Ctrl+L");
        expect(await openedUrls(session), "#不具合報告 のリンクを開こうとしていない").toEqual([BUG_REPORT_CHANNEL_URL]);

        // クリップボードには記録ファイルの完全な場所。実在し、中身は記録の形
        const copied = await clipboardText(session);
        expect(path.isAbsolute(copied), `完全な場所でない：${copied}`).toBe(true);
        expect(path.normalize(path.dirname(copied))).toBe(path.normalize(path.join(session.workFolder, ".aiwriter", "reports")));
        expect(copied).toMatch(/NAI-\d{8}-[a-z0-9]{4}\.md$/);
        expect((await stat(copied)).isFile()).toBe(true);
        expect(await readFile(copied, "utf8")).toContain("# 要約");

        // ［サーバーに参加する］：招待のリンクを開こうとし、手順の窓は出直す
        await pressDialogButton(page, JOIN_COMMUNITY_LABEL);
        await waitStepsDialog(page, "［サーバーに参加する］のあと、手順の窓が出直す");
        expect(await openedUrls(session)).toEqual([BUG_REPORT_CHANNEL_URL, COMMUNITY_DISCORD_URL]);

        // ［場所をもう一度写す］：ほかの物に替わったクリップボードが、記録ファイルの場所に戻る
        await session.app.evaluate(({ clipboard }) => clipboard.writeText("ほかに写したもの"));
        await pressDialogButton(page, COPY_REPORT_PATH_AGAIN_LABEL);
        await waitStepsDialog(page, "［場所をもう一度写す］のあと、手順の窓が出直す");
        expect(await clipboardText(session)).toBe(copied);

        // 窓を閉じると、書き出したあとの案内がもう一度出る（要約をコピーする道も残る）
        await page.keyboard.press("Escape");
        await waitDialogClosed(page, "手順の窓が閉じる");
        expect(await waitDoneButtons(page, "窓を閉じたあと、書き出したあとの案内が出直す")).toContain("要約をコピー");
        expect(await openedUrls(session), "閉じただけでリンクを開いた").toHaveLength(2);
      } finally {
        await session.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), before).catch(() => undefined);
      }
    },
    { globalState: { "novelai.siteLink.browserGuideShown": true } }
  );
}, 240_000);
