/**
 * 修正版の出し直し（画面の自動テスト、設計書6.68.7・6.113。作者の依頼 2026-11-03「修正後再投稿に対応してください」）。
 *
 * 単体テスト（`test/unit/features/postingKitRevision.test.ts`）は選ぶ画面を作り物で答えている。ここでは本物の
 * VS Code で、**作品一覧の話の右クリック「この話を投稿する」から出し直しへ届くか**を見る：
 *
 * - カクヨムへは出した・なろうはまだの話を右クリック →「この話を投稿する」→ 出し方の問いが出る
 *   （先頭は今までどおり「未投稿のサイトへ出す」、次に「修正版を出し直す」）
 * - 「修正版を出し直す」→ サイトを選ぶ画面には投稿済みのカクヨムだけが並ぶ → Enter
 * - 題「… の修正版を カクヨム へ」の案内が出る。本文がクリップボードに入り、開こうとしたのは
 *   **作品の管理画面**（`/my/works/{作品ID}`）で、新しい話の投稿ページではない
 * - 「出し直しました」→ 台帳の `revisions` に1件入り（出し直したときの本文の印つき）、`posts` は1件のまま。
 *   告知の質問は出ない
 * - 作品の「新話投稿」を押すと、投稿のあとに本文を直した話（台帳の印と今の本文が違う話）があれば、
 *   話を選ぶ前に「… は投稿後に直しています。出し直しますか」と促す（作者の裁定 2026-11-03 昼）
 *
 * **外のブラウザは開かせない**（`postingKitSteps.test.ts` と同じく本体側の `shell.openExternal` を替える）。
 * AI は呼ばない。クリップボードは本物の OS のものを通るので、走らせたあと前の中身へ戻す。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { SIDEBAR_LAUNCH, collapseSidebarPane, expandTreeRow, showSidebar, treeContextMenu, waitTreeSettled } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  dialogText,
  pickQuickPickRow,
  quickPickPlaceholder,
  quickPickRows,
  quickPickTitle,
  pressDialogButton,
} from "./support/workbenchDom";
import { runCommand } from "./support/quickInput";
import { postingTextHash } from "../../src/core/postingBodyHash";

const EPISODES = [
  { name: "第1話_はじまり.txt", text: "　朝の駅は静かだった。\n　直したあとの一文。\n" },
  { name: "第2話_つづき.txt", text: "　二話の本文。\n" },
];
const KAKUYOMU_POST_URL = "https://kakuyomu.jp/my/works/1177354054934574437/episodes/new";
const KAKUYOMU_MANAGE_URL = "https://kakuyomu.jp/my/works/1177354054934574437";
const NAROU_POST_URL = "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/";
/** 投稿したときの本文（いまの第1話は、このあとに「直したあとの一文。」を足した） */
const POSTED_TEXT = "　朝の駅は静かだった。\n";
const POSTED = {
  episodePath: "本文/第1話_はじまり.txt",
  site: "kakuyomu",
  postedAt: "2026-10-01T00:00:00.000Z",
  // 題と本文の両方の印（0.124.1 の取り方）。題はファイル名から読む「はじまり」
  bodyHash: postingTextHash("はじまり", POSTED_TEXT),
};

/** カクヨムへは出した・なろうはまだ */
const LEDGER = {
  schemaVersion: "1",
  sites: [
    { site: "narou", newEpisodeUrl: NAROU_POST_URL },
    { site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST_URL },
  ],
  posts: [POSTED],
};

const LAUNCH = {
  ...SIDEBAR_LAUNCH,
  globalState: { "novelai.siteLink.browserGuideShown": true },
  prepareWork: async ({ workFolder }: { workFolder: string }) => {
    await mkdir(path.join(workFolder, "設定"), { recursive: true });
    await writeFile(path.join(workFolder, "設定", "投稿状態.json"), `${JSON.stringify(LEDGER, null, 2)}\n`, "utf8");
  },
};

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

async function ledger(session: E2ESession): Promise<{ posts?: unknown[]; revisions?: Array<Record<string, unknown>> }> {
  const text = await readFile(path.join(session.workFolder, "設定", "投稿状態.json"), "utf8");
  return JSON.parse(text) as { posts?: unknown[]; revisions?: Array<Record<string, unknown>> };
}

/** 選ぶ画面の題が `needle` を含むまで待つ。VS Code 自身の「外のサイトを開きますか」は［Open］で進める */
async function waitTitle(page: Page, needle: string, what: string): Promise<string> {
  let title: string | undefined;
  await waitUntil(
    async () => {
      const dialog = await dialogText(page);
      if (dialog?.includes("open the external website")) {
        await pressDialogButton(page, "Open").catch(() => undefined);
        return false;
      }
      title = await quickPickTitle(page);
      return title !== undefined && title.includes(needle);
    },
    what,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの題：${JSON.stringify(title)}／行：${JSON.stringify((await quickPickRows(page).catch(() => [])).map((row) => row.label))}）`);
  });
  return title ?? "";
}

test("話の右クリック「この話を投稿する」から修正版を出し直せる：管理画面を開き、出し直しの記録は投稿の記録と別に残る", async () => {
  await withVsCode(
    "修正版の出し直し",
    EPISODES,
    async (session) => {
      const { page } = session;
      const before = await session.app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "");
      try {
        await blockBrowser(session);
        await showSidebar(page, E2E_WORK_TITLE);
        await collapseSidebarPane(page, "AIに相談");
        await expandTreeRow(page, E2E_WORK_TITLE);
        await waitTreeSettled(page);

        await treeContextMenu(page, "第1話", "この話を投稿する");
        await waitTitle(page, "の出し方", "出し方の問いが出る");
        const modes = (await quickPickRows(page)).map((row) => row.label);
        expect(modes[0] ?? "", `先頭が「未投稿のサイトへ出す」ではない（${JSON.stringify(modes)}）`).toContain("未投稿のサイトへ出す");
        expect(modes.some((label) => label.includes("修正版を出し直す")), `「修正版を出し直す」が無い（${JSON.stringify(modes)}）`).toBe(true);

        await pickQuickPickRow(page, "修正版を出し直す");
        await waitTitle(page, "修正版を出し直すサイト", "出し直すサイトを選ぶ画面が出る");
        const sites = (await quickPickRows(page)).map((row) => row.label);
        expect(sites.some((label) => label.includes("カクヨム")), `カクヨムが並ばない（${JSON.stringify(sites)}）`).toBe(true);
        expect(sites.some((label) => label.includes("小説家になろう")), `未投稿のなろうが並んだ（${JSON.stringify(sites)}）`).toBe(false);
        // 投稿のあとに直したカクヨムに既定で印が付いている。Enter でそのまま決める
        await page.keyboard.press("Enter");

        await waitTitle(page, "の修正版を カクヨム へ", "「… の修正版を カクヨム へ」の案内が出る");
        await waitUntil(async () => (await openedUrls(session)).length > 0, "作品の管理画面を開こうとする", 15_000);
        expect(await openedUrls(session), "開いたのが作品の管理画面ではない（新しい話の投稿ページを開くと、修正版が新しい話として公開される）").toEqual([
          KAKUYOMU_MANAGE_URL,
        ]);
        expect(await session.app.evaluate(({ clipboard }) => clipboard.readText()), "本文がクリップボードに入っていない").toContain("直したあとの一文。");
        const rows = (await quickPickRows(page)).map((row) => row.label);
        expect(rows.some((label) => label.includes("ヘルパーへ渡す形でコピー")), `出し直しで封筒が出た（${JSON.stringify(rows)}）`).toBe(false);

        await pickQuickPickRow(page, "出し直しました");
        await waitUntil(async () => ((await ledger(session)).revisions ?? []).length === 1, "台帳に出し直しの記録が1件入る", 20_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（台帳：${JSON.stringify(await ledger(session))}）`);
          }
        );
        const saved = await ledger(session);
        expect(saved.posts, "投稿の記録が変わった（出し直しは新しい話として数えない）").toEqual([POSTED]);
        expect(saved.revisions?.[0]).toMatchObject({
          episodePath: "本文/第1話_はじまり.txt",
          site: "kakuyomu",
          // 出し直したときの題と本文の印（次に「直したか」を比べる相手になる）
          bodyHash: postingTextHash("はじまり", EPISODES[0].text),
        });

        // 告知の質問は出さない（新しい話ではない）
        await page.waitForTimeout(1_500);
        expect(await quickPickTitle(page), "出し直しのあとに告知の質問が出た").not.toBe("投稿おつかれさまでした");
      } finally {
        await session.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), before).catch(() => undefined);
      }
    },
    LAUNCH
  );
}, 180_000);

test("作品の「新話投稿」で、投稿のあとに直した話があれば出し直しを促し、選ぶと出し直しの流れへ進む", async () => {
  await withVsCode(
    "新話投稿での出し直しの促し",
    EPISODES,
    async (session) => {
      const { page } = session;
      const before = await session.app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "");
      try {
        await blockBrowser(session);
        await runCommand(page, "新話投稿");
        await waitTitle(page, "投稿のあとに直した話があります", "出し直しの促しが出る");
        const placeHolder = await quickPickPlaceholder(page);
        expect(placeHolder ?? "", "促しの文が違う").toContain("は投稿後に直しています。出し直しますか");
        const rows = (await quickPickRows(page)).map((row) => row.label);
        expect(rows.some((label) => label.includes("第1話") && label.includes("出し直す")), `第1話の出し直しが無い（${JSON.stringify(rows)}）`).toBe(true);
        // 直していない第2話は並べない。未投稿の話があるので「新しい話を投稿する」で先へ進める
        expect(rows.some((label) => label.includes("第2話")), `直していない第2話が並んだ（${JSON.stringify(rows)}）`).toBe(false);
        expect(rows.some((label) => label.includes("新しい話を投稿する")), `「新しい話を投稿する」が無い（${JSON.stringify(rows)}）`).toBe(true);

        await pickQuickPickRow(page, "を出し直す");
        await waitTitle(page, "修正版を出し直すサイト", "出し直すサイトを選ぶ画面が出る");
        await page.keyboard.press("Enter");
        await waitTitle(page, "の修正版を カクヨム へ", "「… の修正版を カクヨム へ」の案内が出る");
        await waitUntil(async () => (await openedUrls(session)).length > 0, "作品の管理画面を開こうとする", 15_000);
        expect(await openedUrls(session)).toEqual([KAKUYOMU_MANAGE_URL]);

        await pickQuickPickRow(page, "出し直しました");
        await waitUntil(async () => ((await ledger(session)).revisions ?? []).length === 1, "台帳に出し直しの記録が1件入る", 20_000);
        expect((await ledger(session)).posts, "投稿の記録が変わった").toEqual([POSTED]);

        // 未投稿の話が残っているので、続けて新しい話を投稿するかを訊く（作者の答え 2026-11-03 昼）
        await waitTitle(page, "続けて新しい話を投稿しますか", "続けて新しい話を投稿するかを訊く");
        await pickQuickPickRow(page, "続けて新しい話を投稿する");
        await waitTitle(page, "小説家になろう", "未投稿の話の新しい話の案内（なろう）が出る");
        await pickQuickPickRow(page, "中止する");
        expect((await ledger(session)).revisions ?? [], "続けた新話投稿で、出し直しの記録が消えた").toHaveLength(1);
      } finally {
        await session.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), before).catch(() => undefined);
      }
    },
    LAUNCH
  );
}, 180_000);
