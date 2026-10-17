/**
 * 新話投稿（投稿キット）の1サイトぶんの選ぶ画面の動き（画面の自動テスト、設計書6.68.3・6.113。2026-10-18）。
 * 実機確認リスト「『サブタイトルをコピー』『このサイトは飛ばす』『中止』が効くか。全サイト済みで告知の質問
 * （既定は作らない）が出るか」を機械へ移したもの。
 *
 * **外のブラウザは開かせない。** 製品は投稿ページを `vscode.env.openExternal` で開く（作者の既定のブラウザ）。
 * そのまま走らせると、試験のたびに本物のブラウザが起きる。テスト用の VS Code の本体側（Electron の主プロセス）で
 * `shell.openExternal` を、開く URL を控えるだけの関数に替える（ブラウザは起きない）。
 * 開こうとした URL は控えを読んで確かめる。サイトの案内の窓（初回だけ出る「リンクは…で開きます」）は、
 * 覚えの印（`novelai.siteLink.browserGuideShown`）を先に置いて出さない。
 *
 * 見張るのは次のとおり（AI は呼ばない。クリップボードは本物の OS のものを通る。走らせたあと前の中身へ戻す）：
 * - 最初の画面：本文をクリップボードへ入れ、投稿ページの URL を開こうとする（1回）。選ぶ画面の題は
 *   「<話の見出し> を カクヨム へ」で、選択肢に［サブタイトルをコピー］［このサイトは飛ばす］［中止する］がある
 * - ［サブタイトルをコピー］：クリップボードがサブタイトルになり、選ぶ画面はもう一度出る（続けて選び直せる）
 * - ［このサイトは飛ばす］：記録せずに終わり、「…は飛ばしました」の知らせが出る。投稿の記録は増えない
 * - ［中止する］：「途中で中止しました」が出て、投稿の記録は増えない
 * - ［投稿しました］：投稿の記録が1件入り、**告知の質問「投稿おつかれさまでした」**が出る。先頭の答えは
 *   「告知は作らずに終わる」（既定は作らない）。それを選ぶと何も作らず終わる
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { runCommand } from "./support/quickInput";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { dialogText, pickQuickPickRow, quickPickRows, quickPickTitle, pressDialogButton } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const BODY = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";
const POST_URL = "https://kakuyomu.jp/my/works/0000000000/episodes/new";

/** 投稿状態（設定/投稿状態.json）：カクヨムだけ登録済み・投稿の記録はまだ無い */
const LEDGER = { schemaVersion: "1", sites: [{ site: "kakuyomu", newEpisodeUrl: POST_URL }], posts: [] };

const LAUNCH = {
  globalState: { "novelai.siteLink.browserGuideShown": true },
  prepareWork: async ({ workFolder }: { workFolder: string }) => {
    await mkdir(path.join(workFolder, "設定"), { recursive: true });
    await writeFile(path.join(workFolder, "設定", "投稿状態.json"), `${JSON.stringify(LEDGER, null, 2)}\n`, "utf8");
  },
};

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

async function ledgerPosts(session: E2ESession): Promise<unknown[]> {
  const text = await readFile(path.join(session.workFolder, "設定", "投稿状態.json"), "utf8");
  return (JSON.parse(text) as { posts?: unknown[] }).posts ?? [];
}

async function clipboardText(session: E2ESession): Promise<string> {
  return session.app.evaluate(({ clipboard }) => clipboard.readText());
}

/** 選ぶ画面の題（`<話の見出し> を カクヨム へ`）が出るまで待つ */
const opened: string[] = [];
async function waitWalk(page: Page, what: string): Promise<string> {
  let title: string | undefined;
  await waitUntil(
    async () => {
      // VS Code 自身の「外のサイトを開きますか」（Do you want Code to open the external website?）が先に出る。
      // 本物のブラウザは起きない（本体側で `shell.openExternal` を替えてある）ので、［Open］を押して進める
      const dialog = await dialogText(page);
      if (dialog?.includes("open the external website")) {
        opened.push(dialog.replace(/\s+/g, " ").trim());
        await pressDialogButton(page, "Open").catch(() => undefined);
        return false;
      }
      title = await quickPickTitle(page);
      return title !== undefined && title.includes("カクヨム");
    },
    what,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの題：${JSON.stringify(title)}／行：${JSON.stringify((await quickPickRows(page).catch(() => [])).map((row) => row.label))}）`);
  });
  return title ?? "";
}

/** 1つずつ、本物のクリップボードを控えて戻すための外枠 */
async function withClipboardRestored(session: E2ESession, body: () => Promise<void>): Promise<void> {
  const before = await session.app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "");
  try {
    await body();
  } finally {
    await session.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), before).catch(() => undefined);
  }
}

test("新話投稿：本文をコピーして投稿ページを開こうとし、［サブタイトルをコピー］でクリップボードが替わって画面が戻り、［このサイトは飛ばす］で記録せずに終わる", async () => {
  await withVsCode(
    "投稿キットの案内",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      await withClipboardRestored(session, async () => {
        await blockBrowser(session);
        await runCommand(page, "新話投稿");
        const title = await waitWalk(page, "投稿の選ぶ画面「… を カクヨム へ」が出る");

        // 本文がクリップボードに入り、投稿ページを開こうとした（外には開かせていない）
        expect(await clipboardText(session), "本文がクリップボードに入っていない").toContain("朝の駅は静かだった。");
        expect(await openedUrls(session), "投稿ページの URL を開こうとしていない").toEqual([POST_URL]);
        const rows = await quickPickRows(page);
        const labels = rows.map((row) => row.label);
        for (const wanted of ["投稿しました", "サブタイトルをコピー", "本文をもう一度コピー", "このサイトは飛ばす"]) {
          expect(labels.some((label) => label.includes(wanted)), `選択肢に「${wanted}」が無い（${JSON.stringify(labels)}）`).toBe(true);
        }

        // ［サブタイトルをコピー］：クリップボードがサブタイトルになり、選ぶ画面がもう一度出る
        const detail = await page.locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: "サブタイトルをコピー" }).first().innerText();
        const subtitle = /「(.+?)」を題名の欄へ貼れます/.exec(detail)?.[1];
        expect(subtitle, `サブタイトルを読み取れていない（行の字：${JSON.stringify(detail)}）`).toBeTruthy();
        await pickQuickPickRow(page, "サブタイトルをコピー");
        await waitUntil(async () => (await clipboardText(session)) === subtitle, `クリップボードがサブタイトル「${subtitle}」になる`, 10_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（クリップボード：${JSON.stringify(await clipboardText(session))}）`);
          }
        );
        await waitUntil(async () => (await quickPickTitle(page)) === title, "選ぶ画面がもう一度出る（続けて選び直せる）", 10_000);
        expect(await openedUrls(session), "［サブタイトルをコピー］で、投稿ページをもう一度開いた").toHaveLength(1);

        // ［このサイトは飛ばす］：記録せずに終わり、知らせが出る
        await pickQuickPickRow(page, "このサイトは飛ばす");
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 10_000);
        await waitUntil(
          async () => (await page.locator(".notification-toast", { hasText: "飛ばしました" }).count()) > 0,
          "「…は飛ばしました」の知らせが出る",
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await page.locator(".notification-toast").allInnerTexts())}）`);
        });
        expect(await ledgerPosts(session), "飛ばしたのに、投稿の記録が入った").toEqual([]);
      });
    },
    LAUNCH
  );
}, 180_000);

test("新話投稿：［中止する］で「途中で中止しました」が出て、投稿の記録は増えない", async () => {
  await withVsCode(
    "投稿キットの中止",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      await withClipboardRestored(session, async () => {
        await blockBrowser(session);
        await runCommand(page, "新話投稿");
        await waitWalk(page, "投稿の選ぶ画面が出る");
        await pickQuickPickRow(page, "中止する");
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 10_000);
        await waitUntil(
          async () => (await page.locator(".notification-toast", { hasText: "途中で中止しました" }).count()) > 0,
          "「途中で中止しました」の知らせが出る",
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await page.locator(".notification-toast").allInnerTexts())}）`);
        });
        expect(await ledgerPosts(session), "中止したのに、投稿の記録が入った").toEqual([]);
      });
    },
    LAUNCH
  );
}, 180_000);

test("新話投稿：［投稿しました］で記録が1件入り、告知の質問「投稿おつかれさまでした」が出て、先頭の答えは「告知は作らずに終わる」", async () => {
  await withVsCode(
    "投稿キットの告知の質問",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      await withClipboardRestored(session, async () => {
        await blockBrowser(session);
        await runCommand(page, "新話投稿");
        await waitWalk(page, "投稿の選ぶ画面が出る");
        await pickQuickPickRow(page, "投稿しました");

        // 記録が1件入る
        await waitUntil(async () => (await ledgerPosts(session)).length === 1, "投稿の記録が1件入る", 20_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（記録：${JSON.stringify(await ledgerPosts(session))}）`);
        });
        const [post] = (await ledgerPosts(session)) as Array<{ episodePath?: string; site?: string }>;
        expect(post.site, "記録のサイト").toBe("kakuyomu");
        expect(post.episodePath ?? "", "記録の話の場所").toContain("001_はじまり");

        // 告知の質問：先頭の答えは「作らない」（既定の答えが作る側ではない）
        await waitUntil(async () => (await quickPickTitle(page)) === "投稿おつかれさまでした", "告知の質問「投稿おつかれさまでした」が出る", 20_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（いまの題：${JSON.stringify(await quickPickTitle(page))}）`);
          }
        );
        const rows = await quickPickRows(page);
        expect(rows[0]?.label ?? "", `告知の質問の先頭が「作らない」ではない（行：${JSON.stringify(rows.map((row) => row.label))}）`).toContain("告知は作らずに終わる");
        expect(rows.some((row) => row.label.includes("更新告知文を作る")), "「更新告知文を作る」の選択肢が無い").toBe(true);

        // 「作らずに終わる」を選ぶと、何も作らず終わる（選ぶ画面が閉じ、告知の文書ができない）
        await pickQuickPickRow(page, "告知は作らずに終わる");
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 10_000);
        await page.waitForTimeout(1_500);
        expect(await page.locator(".monaco-dialog-box").count(), "告知を作らないと選んだのに、確認の窓が出た").toBe(0);
        expect(await openedUrls(session), "投稿ページを開こうとしたのは1回だけ").toHaveLength(1);
      });
    },
    LAUNCH
  );
}, 180_000);
