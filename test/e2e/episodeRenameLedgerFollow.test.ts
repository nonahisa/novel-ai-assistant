/**
 * 投稿済みの話の名前を変えても、投稿状態の台帳がついてくる（画面の自動テスト、設計書6.68.2・6.113。
 * 0.125.4・0.125.5。作者の決定 2026-11-04）。実機確認リストの 0.125.4・0.125.5 の項目を機械へ移したもの。
 *
 * 台帳（`設定/投稿状態.json`）はパスで話を指すので、名前を変えた話が「未投稿」に見えると、
 * 同じ話をもう一度新しい話として出してしまう。見張る道は3つ：
 *
 * 1. **製品の命令**「ファイル名にサブタイトルを付ける」（右クリック）：知らせに「投稿状態1件」が出て、
 *    台帳の posts のパスが新しい名前になる
 * 2. **エクスプローラーでの改名**（本物のエクスプローラーで F2。`onDidRenameFiles` が鳴る道）：
 *    訊かれずに付け替わり、件数の知らせが出る
 * 3. **VS Code を閉じている間にディスクで名前を変えた**話：開き直して話を開くと、右下に
 *    「…名前が変わった話が1つあります。…付け替えますか」が1回だけ出る。［付け替える］で台帳が
 *    新しい名前になる。［付け替えない］を選ぶと、開き直しても同じ組では訊かれない
 *
 * AI は呼ばない。GitHub も呼ばない。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { runCommand } from "./support/quickInput";
import { SIDEBAR_LAUNCH, showSidebar, treeContextMenu, treeRowLabels, treeRow, waitTreeSettled } from "./support/sidebar";
import { E2E_WORK_TITLE, restartVsCode, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { dialogText, notificationTexts, pressDialogButton, pressWorkbenchKey, quickOpen, statusBarTexts } from "./support/workbenchDom";
import { postingTextHash, postingTitleHash } from "../../src/core/postingBodyHash";

const KAKUYOMU_POST_URL = "https://kakuyomu.jp/my/works/1177354054934574437/episodes/new";
const BODY = "　朝の駅は静かだった。\n";

/** 投稿済みの記録（`episodePath` は作品フォルダーからの相対パス） */
function postedRecord(episodePath: string, title: string): Record<string, unknown> {
  return {
    episodePath,
    site: "kakuyomu",
    postedAt: "2026-10-01T00:00:00.000Z",
    bodyHash: postingTextHash(title, BODY),
    titleHash: postingTitleHash(title),
  };
}

function launchWith(episodePath: string, title: string) {
  const ledger = {
    schemaVersion: "1",
    sites: [{ site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST_URL }],
    posts: [postedRecord(episodePath, title)],
  };
  return {
    ...SIDEBAR_LAUNCH,
    globalState: { "novelai.siteLink.browserGuideShown": true },
    prepareWork: async ({ workFolder }: { workFolder: string }) => {
      await mkdir(path.join(workFolder, "設定"), { recursive: true });
      await writeFile(path.join(workFolder, "設定", "投稿状態.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    },
  };
}

async function postedPaths(session: E2ESession): Promise<string[]> {
  const text = await readFile(path.join(session.workFolder, "設定", "投稿状態.json"), "utf8");
  const ledger = JSON.parse(text) as { posts?: Array<{ episodePath: string }> };
  return (ledger.posts ?? []).map((post) => post.episodePath);
}

/** 台帳の posts のパスが `expected` になるまで待つ。落ちるときは今の中身を添える */
async function waitPostedPaths(session: E2ESession, expected: string[], what: string): Promise<void> {
  await waitUntil(
    async () => {
      try {
        return JSON.stringify(await postedPaths(session)) === JSON.stringify(expected);
      } catch {
        // 書き戻しの途中でファイルが一瞬無い
        return false;
      }
    },
    what,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（今の台帳のパス：${JSON.stringify(await postedPaths(session).catch(() => "読めない"))}）`);
  });
}

/** ステータスバーと右下の知らせの字（完了は帯に6秒だけ出る） */
async function noticeLines(page: Page): Promise<string[]> {
  return [...(await statusBarTexts(page)), ...(await notificationTexts(page))];
}

async function waitNotice(page: Page, needle: string, what: string): Promise<string> {
  let found = "";
  await waitUntil(
    async () => {
      found = (await noticeLines(page)).find((text) => text.includes(needle)) ?? "";
      return found !== "";
    },
    what,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの知らせ：${JSON.stringify(await noticeLines(page))}／確認の窓：${(await dialogText(page)) ?? "なし"}）`);
  });
  return found;
}

/** 作品の行を開いて、話の行が並ぶまで待つ */
async function expandWork(page: Page, firstEpisodeHead: string): Promise<void> {
  await showSidebar(page, E2E_WORK_TITLE);
  const workRow = page.locator(`.monaco-list-row[aria-expanded][aria-label*="${E2E_WORK_TITLE}"]`).first();
  await waitUntil(async () => (await workRow.count()) > 0, "作品の行が出る");
  if ((await workRow.getAttribute("aria-expanded")) !== "true") await workRow.click();
  await waitUntil(async () => (await treeRowLabels(page)).some((label) => label.startsWith(firstEpisodeHead)), "作品の下に話が並ぶ");
  await waitTreeSettled(page);
}

test("製品の命令「ファイル名にサブタイトルを付ける」で投稿済みの話の名前を変えると、知らせに投稿状態の件数が出て、台帳のパスが新しい名前になる", async () => {
  await withVsCode(
    "改名の台帳追従（命令）",
    // 名前の題は「旧題」、中の【タイトル】は「はじまり」の話 → 「第1話_はじまり.txt」になる。
    // （名前に題が無く題が中の【タイトル】だけの話は、製品が「既に付いています」と言って変えない。報告済みの疑い）
    [{ name: "第1話_旧題.txt", text: `【タイトル】\nはじまり\n\n【本文】\n${BODY}` }],
    async (session) => {
      const { page } = session;
      await expandWork(page, "第1話");
      expect(await treeRow(page, "第1話").count(), "話の行が無い").toBeGreaterThan(0);
      await treeContextMenu(page, "第1話", "ファイル名にサブタイトルを付ける");
      await waitUntil(async () => ((await dialogText(page)) ?? "").includes("ファイル名を変えます"), "名前を変える確認の窓が出る", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（窓：${(await dialogText(page)) ?? "なし"}／知らせ：${JSON.stringify(await noticeLines(page))}）`);
        }
      );
      await pressDialogButton(page, "変える");

      const notice = await waitNotice(page, "投稿状態1件", "知らせに「投稿状態1件」が出る");
      expect(notice, "付け替えた知らせの文").toContain("投稿状態1件を付け替えました");
      await waitPostedPaths(session, ["本文/第1話_はじまり.txt"], "台帳の posts のパスが新しい名前になる");
    },
    launchWith("本文/第1話_旧題.txt", "旧題")
  );
}, 180_000);

test("エクスプローラー（本物の F2）で投稿済みの話の名前を変えると、訊かれずに台帳が付け替わり、件数の知らせが出る", async () => {
  await withVsCode(
    "改名の台帳追従（エクスプローラー）",
    [{ name: "第1話_はじまり.txt", text: BODY }],
    async (session) => {
      const { page } = session;
      await quickOpen(page, "第1話_はじまり.txt");
      await runCommand(page, "Reveal Active File in Explorer View");
      // エクスプローラーで当該ファイルの行が選ばれて焦点を持つまで待つ
      const row = page.locator(".explorer-viewlet .monaco-list-row.focused, .explorer-viewlet .monaco-list-row.selected", { hasText: "第1話_はじまり" }).first();
      await waitUntil(async () => (await row.count()) > 0, "エクスプローラーで第1話の行が選ばれる", 20_000);
      /*
        行は選ばれても焦点が原稿エディター（WebView）に残ることがあり、F2 が本体に届かず
        名前の入力欄が出なかった回がある。行を押してエクスプローラーへ焦点を移してから F2 を送り、
        出なければ押し直す（3回まで）
      */
      const input = page.locator(".explorer-viewlet .monaco-inputbox input").first();
      for (let attempt = 1; ; attempt++) {
        await row.click();
        await pressWorkbenchKey(page, "F2");
        if (await input.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) break;
        if (attempt === 3) throw new Error(`エクスプローラーの名前の入力欄が出ません（F2 を3回送りました。知らせ：${JSON.stringify(await noticeLines(page))}）`);
      }
      // 名前の入力欄は拡張子の手前までが選ばれているので、そこへ新しい題を打つ
      await page.keyboard.insertText("第1話_出会い");
      await page.keyboard.press("Enter");

      const notice = await waitNotice(page, "投稿状態1件", "知らせに「投稿状態1件」が出る");
      expect(notice, "付け替えた知らせの文").toContain("第1話_はじまり.txt を 第1話_出会い.txt に変えたのに合わせて");
      await waitPostedPaths(session, ["本文/第1話_出会い.txt"], "台帳の posts のパスが新しい名前になる");
      // 訊かれていない（確認の窓も［付け替える］の知らせも出ない）
      expect(await dialogText(page), "訊かずに付け替えるはずが確認の窓が出た").toBeUndefined();
      expect((await notificationTexts(page)).some((text) => text.includes("付け替えますか")), "訊かずに付け替えるはずが問いが出た").toBe(false);
    },
    launchWith("本文/第1話_はじまり.txt", "はじまり")
  );
}, 180_000);

/** 閉じている間にディスクで改名して開き直し、話を開く */
async function renameWhileClosedAndOpen(session: E2ESession): Promise<void> {
  await restartVsCode(session, {
    beforeRelaunch: async () => {
      await rename(path.join(session.manuscriptFolder, "第1話_はじまり.txt"), path.join(session.manuscriptFolder, "第1話_出会い.txt"));
    },
  });
  /*
    作品の登録簿が読み込まれてから話を開く。開き直した直後は登録簿がまだ空のことがあり、
    その間に話を開くと「どの作品の話か」を引けず、確かめが始まらない（開き直しの直後に
    quickOpen すると問いが出ずに30秒待って落ちた回があった。作品の行が見えれば登録簿は読めている）
  */
  await showSidebar(session.page, E2E_WORK_TITLE);
}

const QUESTION = "名前が変わった話が1つあります";

async function questionToasts(page: Page): Promise<string[]> {
  return (await notificationTexts(page)).filter((text) => text.includes(QUESTION));
}

test("閉じている間に名前が変わった投稿済みの話は、開き直して話を開くと1回だけ訊かれ、［付け替える］で台帳が新しい名前になる", async () => {
  await withVsCode(
    "改名の台帳追従（閉じている間）",
    [{ name: "第1話_はじまり.txt", text: BODY }],
    async (session) => {
      await renameWhileClosedAndOpen(session);
      const { page } = session;
      expect(await postedPaths(session), "開き直しただけで台帳が変わった").toEqual(["本文/第1話_はじまり.txt"]);

      await quickOpen(page, "第1話_出会い.txt");
      await waitUntil(async () => (await questionToasts(page)).length > 0, "右下に「名前が変わった話が1つあります」の問いが出る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await noticeLines(page))}）`);
        }
      );
      const toast = (await questionToasts(page))[0];
      expect(toast, "作品名が問いに無い").toContain(`「${E2E_WORK_TITLE}」で`);
      expect(toast, "付け替えますか、の問いになっていない").toContain("付け替えますか");
      // 1回だけ（ほかの話を開いても2枚目は出ない）
      await holdsFor(async () => (await questionToasts(page)).length === 1, "問いが1枚のまま", 4_000);
      // 答える前は台帳は変わらない
      expect(await postedPaths(session)).toEqual(["本文/第1話_はじまり.txt"]);

      await page.locator(".notification-toast .monaco-button", { hasText: "付け替える" }).first().click();
      await waitPostedPaths(session, ["本文/第1話_出会い.txt"], "［付け替える］のあと、台帳の posts のパスが新しい名前になる");
    },
    launchWith("本文/第1話_はじまり.txt", "はじまり")
  );
}, 300_000);

test("開き直してすぐ（作品一覧を待たずに）話を開いても、作品が読み込まれたら1回だけ訊かれる", async () => {
  // 登録簿を読み込む前に開いた話は作品を引けない。製品はその話を覚え、登録簿が変わった合図で
  // もう一度見る（2026-11-04。以前はここで問いが出ず、別の話を開くまで確かめが始まらなかった）
  await withVsCode(
    "改名の台帳追従（開き直してすぐ開く）",
    [{ name: "第1話_はじまり.txt", text: BODY }],
    async (session) => {
      await restartVsCode(session, {
        beforeRelaunch: async () => {
          await rename(path.join(session.manuscriptFolder, "第1話_はじまり.txt"), path.join(session.manuscriptFolder, "第1話_出会い.txt"));
        },
      });
      const { page } = session;
      await quickOpen(page, "第1話_出会い.txt");
      await waitUntil(async () => (await questionToasts(page)).length > 0, "右下に「名前が変わった話が1つあります」の問いが出る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await noticeLines(page))}）`);
        }
      );
      await holdsFor(async () => (await questionToasts(page)).length === 1, "問いが1枚のまま", 4_000);
    },
    launchWith("本文/第1話_はじまり.txt", "はじまり")
  );
}, 300_000);

test("［付け替えない］を選ぶと台帳は変わらず、開き直しても同じ組では訊かれない", async () => {
  await withVsCode(
    "改名の台帳追従（付け替えない）",
    [{ name: "第1話_はじまり.txt", text: BODY }],
    async (session) => {
      await renameWhileClosedAndOpen(session);
      await quickOpen(session.page, "第1話_出会い.txt");
      await waitUntil(async () => (await questionToasts(session.page)).length > 0, "右下に問いが出る", 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await noticeLines(session.page))}）`);
      });
      await session.page.locator(".notification-toast .monaco-button", { hasText: "付け替えない" }).first().click();
      await waitUntil(async () => (await questionToasts(session.page)).length === 0, "問いが閉じる", 10_000);
      expect(await postedPaths(session), "［付け替えない］なのに台帳が変わった").toEqual(["本文/第1話_はじまり.txt"]);

      // 開き直す（ディスクの名前は新しいまま）。同じ組は覚えているので訊かない。
      // 覚えた組（globalState）は書いたあと2秒まで見張って当て直す作り（verifiedMemento の
      // LATE_CHECK_DELAYS_MS）なので、見張りが終わるまで待ってから閉じる（人が押してすぐ閉じる間合いではない）
      await session.page.waitForTimeout(3_000);
      await restartVsCode(session);
      await quickOpen(session.page, "第1話_出会い.txt");
      await holdsFor(async () => (await questionToasts(session.page)).length === 0, "開き直したあと、同じ組では問いが出ない", 8_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await noticeLines(session.page))}）`);
        }
      );
      expect(await postedPaths(session)).toEqual(["本文/第1話_はじまり.txt"]);
    },
    launchWith("本文/第1話_はじまり.txt", "はじまり")
  );
}, 300_000);
