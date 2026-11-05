/**
 * 編集者モードで、作者の原稿へ触れる道が止まること（画面の自動テスト、設計書5.6・6.113。
 * 実機確認リスト 0.121.0 の 330 行と、0.122.0 の 373 行の後半を機械へ移した）。
 *
 * 1. 330（作者の判断 2026-11-01、洗い出しの3「戻し方まで言う」）：編集者モードで本文に書き換えがあるまま
 *    「校閲を終えて返す」を押すと、送らずに止まり、知らせに［ソース管理を開く］と「戻す話を右クリックして
 *    「変更を破棄」」の1文が出る。押すと VS Code のソース管理が開く。送り先（GitHub の代わりの裸の置き場）には
 *    何も届かず、本文の書き換えは残る（ここでは戻さない）
 * 2. 373 の後半（作者の判断 2026-11-02）：編集者モードの詳細メニュー「作品管理」→「GitHub作品管理」に
 *    「分岐合流」が無く、コマンドパレットから「分岐合流」を押すと「編集者モードでは、2台の原稿を合わせる操作は
 *    使えません。…「校閲を終えて返す」で提案を作者へ返してください。」と出る
 *
 * 項目は「2環境」（作者と編集者の機械）を前提に書かれているが、ここで見ているのは**編集者の機械の中だけで
 * 起きること**（本文の書き換えの検査・断りの文）なので、1台の中で見られる（単体テスト
 * `finishReviewDeadEnd.test.ts` と同じ形を、本物の git と VS Code で通す）。
 *
 * **GitHub は呼ばない。** 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts`）。
 * 編集者モードは起こす前の設定（`novelai.mode: "editor"`）で入れる（切り替えの確認の窓は
 * `editorModeReviewLock` が見ている）。**AI は呼ばない。**
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { expect, test } from "vitest";
import { describeBlocked } from "../../src/core/editorMode";
import { addLocalRemote, git, gitWhileRunning, initRepoWithFirstCommit, porcelainLines } from "./support/gitFixture";
import { describeNotices } from "./support/noticeRecord";
import { runCommand } from "./support/quickInput";
import { SIDEBAR_LAUNCH, collapseSidebarPane } from "./support/sidebar";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, dialogText, notificationTexts, pressWorkbenchKey, quickInputWaitContext } from "./support/workbenchDom";

/** 左の列を出すキー（`support/sidebar.ts` の SHOW_SIDEBAR_KEY と同じ組。SIDEBAR_LAUNCH が割り当てる） */
const SHOW_SIDEBAR_PRESS = "Control+Alt+Shift+KeyJ";

const EPISODE = "001_駅.txt";
const TEXT = "　終電を逃した駅のホームに、雨の音だけが残っていた。\n";
const EDITED = "　終電を逃した駅のホームに、雨の音だけが残っていた（編集者が書き換えた）。\n";

/**
 * 止まったときの知らせの文の芯（`features/finishReview.ts`。features は vscode を読むので
 * テストからは呼べず、文をここへ写す。文を直したらここも直す）
 */
const STOPPED_HEAD = "本文に未記録の変更があるため、送らずに止めました";
const UNDO_HINT = "戻す話を右クリックして「変更を破棄」を選ぶと元に戻せます。";
const OPEN_SCM = "ソース管理を開く";

const LAUNCH: LaunchOptions = {
  settings: {
    ...SIDEBAR_LAUNCH.settings,
    "novelai.mode": "editor",
    "novelai.git.autoResend": false,
    "novelai.git.autoFetch": false,
  },
  keybindings: SIDEBAR_LAUNCH.keybindings,
  prepareWork: async ({ workFolder }) => {
    const root = path.dirname(path.dirname(workFolder));
    await initRepoWithFirstCommit(workFolder);
    await addLocalRemote(workFolder, path.join(root, "送り先.git"));
  },
};

function remoteFolder(session: E2ESession): string {
  return path.join(path.dirname(path.dirname(session.workFolder)), "送り先.git");
}

/** 登録の印を記録して送り、作品を「作者の最新を受け取った」きれいな状態にする */
async function settleRegistration(session: E2ESession): Promise<void> {
  const { page, workFolder } = session;
  await waitUntil(() => existsSync(path.join(workFolder, ".aiwriter", "config.json")), "登録の印（config.json）ができる", 30_000);
  await page.waitForTimeout(2_500);
  await gitWhileRunning(workFolder, ["add", "-A"]);
  await gitWhileRunning(workFolder, ["commit", "--quiet", "--allow-empty", "-m", "登録の印"]);
  await gitWhileRunning(workFolder, ["push", "--quiet"]);
  if ((await porcelainLines(workFolder)).length > 0) {
    throw new Error(`登録の印を記録したのに、記録待ちが残っています：${JSON.stringify(await porcelainLines(workFolder))}`);
  }
  await clearNotifications(page);
}

/** 左の列の見出しが「ソース管理」（英語の画面では Source Control）か */
async function sourceControlShown(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const title = (document.querySelector(".part.sidebar .composite.title")?.textContent ?? "").trim();
    return /source control|ソース管理/i.test(title);
  });
}

async function sidebarTitle(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector(".part.sidebar .composite.title")?.textContent ?? "").trim());
}

test("編集者モードで本文に書き換えがあるまま「校閲を終えて返す」を押すと、送らずに止まり、知らせに［ソース管理を開く］と戻し方の1文が出て、押すとソース管理が開き、送り先には何も届かない", async () => {
  await withVsCode(
    "編集者モードの本文の書き換えで止まる",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page, workFolder } = session;
      await settleRegistration(session);
      const before = (await git(remoteFolder(session), ["rev-parse", "main"])).trim();

      // 編集者が本文を書き換えてしまった（保存まで済んだ）
      const file = path.join(session.manuscriptFolder, EPISODE);
      await writeFile(file, EDITED, "utf8");

      await runCommand(page, "校閲を終えて返す");
      let notice = "";
      await waitUntil(
        async () => {
          notice = (await notificationTexts(page)).find((text) => text.includes(STOPPED_HEAD)) ?? "";
          return notice !== "";
        },
        `「${STOPPED_HEAD}」の知らせが出る`,
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／窓：${JSON.stringify(await dialogText(page))}）${await quickInputWaitContext(page)}`);
      });
      const oneLine = notice.replace(/\s+/g, " ");
      // 書き換えた話の名前を挙げる（登録の印など、話でないファイルで止まったのではない）
      expect(oneLine, `知らせに書き換えた話の名前がありません：${oneLine}`).toContain(EPISODE);
      expect(oneLine, `知らせに戻し方の1文がありません：${oneLine}`).toContain(UNDO_HINT);
      // 送る前の確認の窓（［返す］）は出ない
      expect(await dialogText(page), "止まるはずなのに、返す前の確認の窓が出ました").toBeUndefined();

      const toast = page.locator(".notification-toast", { hasText: STOPPED_HEAD }).first();
      const button: Locator = toast.locator(".monaco-button", { hasText: OPEN_SCM }).first();
      expect(await button.count(), `知らせに［${OPEN_SCM}］がありません`).toBe(1);
      await button.click();
      await waitUntil(() => sourceControlShown(page), "［ソース管理を開く］で VS Code のソース管理が開く", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（左の列の見出し：${JSON.stringify(await sidebarTitle(page))}）`);
      });

      // 送り先には何も届かず、本文の書き換えは残る（ここでは戻さない）
      await holdsFor(async () => (await git(remoteFolder(session), ["rev-parse", "main"])).trim() === before, "送り先に何も届かない", 3_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeNotices(session)}）`);
      });
      expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n"), "止めたのに本文を戻しました").toBe(EDITED);
      // git は日本語のファイル名を既定で「\」の連なりへ化かすので、化かさない指定で読む
      const pending = await gitWhileRunning(workFolder, ["-c", "core.quotepath=false", "status", "--porcelain"]);
      expect(pending, "本文の書き換えが記録待ちから消えました").toContain(EPISODE);
    },
    LAUNCH
  );
}, 300_000);

/** 詳細メニューの区画の中で、名前が `head` で始まる行を、描かれるまで区画を下へ送って探す */
async function detailRow(page: Page, head: string): Promise<Locator> {
  const pane = page.locator(".pane", { has: page.locator(".pane-header", { hasText: "詳細メニュー" }) }).first();
  const row = pane.locator(`.monaco-list-row[aria-label^="${head}"]`).first();
  for (let attempt = 0; attempt < 30 && (await row.count()) === 0; attempt++) {
    const box = await pane.locator(".pane-body").first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
      await page.mouse.wheel(0, 120);
    }
    await page.waitForTimeout(150);
  }
  if ((await row.count()) === 0) throw new Error(`詳細メニューに「${head}」の行が見つかりません`);
  await row.scrollIntoViewIfNeeded();
  return row;
}

/** 詳細メニューで `head` の段を開き、直下の子の名前（見えている名前）を返す */
async function detailChildren(page: Page, head: string): Promise<string[]> {
  const row = await detailRow(page, head);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  await waitUntil(async () => (await row.getAttribute("aria-expanded")) === "true", `詳細メニューの「${head}」が開く`, 10_000);
  await page.waitForTimeout(500);
  return row.evaluate((node) => {
    const level = Number(node.getAttribute("aria-level") ?? "0");
    const index = Number((node as HTMLElement).dataset.index);
    const list = node.parentElement;
    const rows = Array.from(list?.querySelectorAll(".monaco-list-row") ?? []).sort(
      (a, b) => Number((a as HTMLElement).dataset.index) - Number((b as HTMLElement).dataset.index)
    );
    const children: string[] = [];
    for (const other of rows) {
      const otherIndex = Number((other as HTMLElement).dataset.index);
      if (otherIndex <= index) continue;
      const otherLevel = Number(other.getAttribute("aria-level") ?? "0");
      if (otherLevel <= level) break;
      if (otherLevel === level + 1) children.push((other.querySelector(".label-name")?.textContent ?? other.getAttribute("aria-label") ?? "").trim());
    }
    return children;
  });
}

test("編集者モードの詳細メニュー「GitHub作品管理」に「分岐合流」が無く、コマンドパレットから「分岐合流」を押すと「校閲を終えて返す」へ案内して止まる", async () => {
  await withVsCode(
    "編集者モードの分岐合流",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await settleRegistration(session);
      // 作品一覧の行は「［記録待ちN］画面テストの作品」の形になることがあり、行の頭で待つ showSidebar は使わない
      await pressWorkbenchKey(page, SHOW_SIDEBAR_PRESS);
      await page.locator(".pane-header", { hasText: "詳細メニュー" }).first().waitFor({ state: "visible", timeout: 15_000 });
      await collapseSidebarPane(page, "AIに相談");
      // 編集者モードでは簡単ステップメニューが出ず、一番上に編集者メニューが出る（0.128.0。設計書5.6.6）
      await collapseSidebarPane(page, "編集者メニュー");

      await detailChildren(page, "作品管理");
      const github = await detailChildren(page, "GitHub作品管理");
      expect(github.length, "「GitHub作品管理」の中が読めません").toBeGreaterThan(0);
      expect(github, `編集者モードの「GitHub作品管理」：${JSON.stringify(github)}`).not.toContain("分岐合流");

      const blocked = describeBlocked("novelai.resolveDivergence");
      await clearNotifications(page);
      await runCommand(page, "分岐合流");
      await waitUntil(async () => (await notificationTexts(page)).some((text) => text.replace(/\s+/g, "").includes(blocked.replace(/\s+/g, ""))), "編集者モードの断りが出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
        }
      );
      expect(blocked).toContain("「校閲を終えて返す」で提案を作者へ返してください。");
      // 断っただけで、そろえる窓も作品を選ぶ画面も出ない
      await holdsFor(async () => (await dialogText(page)) === undefined, "断ったあとに確認の窓が出ない", 2_000);
    },
    LAUNCH
  );
}, 300_000);
