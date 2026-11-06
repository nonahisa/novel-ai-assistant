/**
 * ルビ・傍点の入った .txt を投稿したと記録してから .md 化しても、「新話投稿」で出し直しを促さない
 * （画面の自動テスト、設計書6.68.7・6.12.4・6.113。0.127.0）。実機確認リストの 0.127.0 の項目
 * 「｜漢字《かんじ》や《《強調》》の入った .txt の話を投稿キットで投稿したと記録してから .md 化しても、
 * 作品の「新話投稿」で「投稿のあとに直した話があります」が出ない。1字直すと出る」を機械へ移したもの。
 *
 * 単体テスト postingMarkdownConvertRevision は選ぶ画面を作り物で答えている。ここでは本物の VS Code で：
 *
 * 1. 「新話投稿」→［投稿しました］で、**製品の道で**投稿の記録を作る（印を台帳へ先に置かない。
 *    取り方をテストの側で決め打ちすると、記録の取り方を変えたときに何を確かめたのか分からなくなる）
 * 2. 作品一覧の右クリック「本文 .md 化」→ .md ができ、ルビ・傍点が {漢字|かんじ}・{{強調}} に直り、台帳が .md を指す
 * 3. もう一度「新話投稿」→ 促しは出ず、未投稿の第2話の案内へ進む
 * 4. .md の本文を1字直して「新話投稿」→「投稿のあとに直した話があります」が出て、第1話が並ぶ
 *
 * **外のブラウザは開かせない**（本体側の `shell.openExternal` を替える）。AI は呼ばない。
 * クリップボードは本物の OS のものを通るので、走らせたあと前の中身へ戻す。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { runCommand } from "./support/quickInput";
import { SIDEBAR_LAUNCH, collapseSidebarPane, showSidebar, treeContextMenu, treeRowLabels, waitTreeSettled } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  dialogText,
  notificationTexts,
  pickQuickPickRow,
  pressDialogButton,
  quickPickPlaceholder,
  quickPickRows,
  quickPickTitle,
  statusBarTexts,
} from "./support/workbenchDom";

const TXT_NAME = "第1話_雪の朝.txt";
const MD_NAME = "第1話_雪の朝.md";
/** 投稿サイトの書き方のルビ・傍点（縦線あり・縦線なし・カクヨムの傍点） */
const SITE_TEXT = "　｜白銀《しろがね》の街に、雪《ゆき》が降っていた。\n　《《それ》》は、誰も知らない約束だった。\n";
const EPISODES = [
  { name: TXT_NAME, text: SITE_TEXT },
  { name: "第2話_つづき.txt", text: "　二話の本文。\n" },
];
const POST_URL = "https://kakuyomu.jp/my/works/1177354054934574437/episodes/new";
const LEDGER = { schemaVersion: "1", sites: [{ site: "kakuyomu", newEpisodeUrl: POST_URL }], posts: [] };
const PROMPT_TITLE = "投稿のあとに直した話があります";

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

interface Ledger {
  posts?: Array<{ episodePath?: string; site?: string; bodyHash?: string }>;
  revisions?: unknown[];
}

/** 台帳を読む。書き換えの最中（退避 → 新規作成）は一瞬無いので、読めるまで待つ */
async function ledger(session: E2ESession): Promise<Ledger> {
  let text = "";
  await waitUntil(
    async () => {
      try {
        text = await readFile(path.join(session.workFolder, "設定", "投稿状態.json"), "utf8");
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    },
    "台帳（設定\\投稿状態.json）が読める",
    10_000
  );
  return JSON.parse(text) as Ledger;
}

/** 選ぶ画面の題が `accept` に合うまで待つ。VS Code 自身の「外のサイトを開きますか」は［Open］で進める */
async function waitTitle(page: Page, accept: (title: string) => boolean, what: string, reject?: (title: string) => boolean): Promise<string> {
  let title: string | undefined;
  await waitUntil(
    async () => {
      const dialog = await dialogText(page);
      if (dialog?.includes("open the external website")) {
        await pressDialogButton(page, "Open").catch(() => undefined);
        return false;
      }
      title = await quickPickTitle(page);
      if (title !== undefined && reject?.(title)) {
        const rows = (await quickPickRows(page).catch(() => [])).map((row) => row.label);
        throw new Error(`出てはいけない画面が出た：題「${title}」／文「${(await quickPickPlaceholder(page)) ?? ""}」／行：${JSON.stringify(rows)}`);
      }
      return title !== undefined && accept(title);
    },
    what,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの題：${JSON.stringify(title)}／行：${JSON.stringify((await quickPickRows(page).catch(() => [])).map((row) => row.label))}）`);
  });
  return title ?? "";
}

async function noticeLines(page: Page): Promise<string[]> {
  return [...(await statusBarTexts(page)), ...(await notificationTexts(page))];
}

test("ルビ・傍点の入った .txt を投稿キットで投稿したと記録してから .md 化しても、新話投稿で出し直しを促さず、1字直すと促す", async () => {
  await withVsCode(
    ".md 化と出し直しの促し",
    EPISODES,
    async (session) => {
      const { page } = session;
      const before = await session.app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "");
      try {
        await blockBrowser(session);

        /* ── 1. 製品の道で、第1話をカクヨムへ投稿したと記録する ── */
        await runCommand(page, "新話投稿");
        await waitTitle(page, (title) => title.includes("カクヨム"), "第1話の投稿の案内が出る");
        await pickQuickPickRow(page, "投稿しました");
        await waitUntil(async () => ((await ledger(session)).posts ?? []).length === 1, "投稿の記録が1件入る", 20_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（台帳：${JSON.stringify(await ledger(session))}）`);
        });
        const [post] = (await ledger(session)).posts ?? [];
        expect(post?.episodePath, "記録の話の場所").toBe(`本文/${TXT_NAME}`);
        expect(post?.bodyHash ?? "", "記録の印は書き方の違いを寄せる取り方（v3:）").toMatch(/^v3:/);
        await waitTitle(page, (title) => title === "投稿おつかれさまでした", "告知の質問が出る");
        await pickQuickPickRow(page, "告知は作らずに終わる");
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 10_000);

        /* ── 2. 作品一覧の右クリック「本文 .md 化」 ── */
        await showSidebar(page, E2E_WORK_TITLE);
        await collapseSidebarPane(page, "AIに相談");
        const workRow = page.locator(`.monaco-list-row[aria-expanded][aria-label*="${E2E_WORK_TITLE}"]`).first();
        await waitUntil(async () => (await workRow.count()) > 0, "作品の行が出る");
        if ((await workRow.getAttribute("aria-expanded")) !== "true") await workRow.click();
        await waitUntil(async () => (await treeRowLabels(page)).some((label) => label.startsWith("第1話")), "作品の下に話が並ぶ");
        await waitTreeSettled(page);
        await treeContextMenu(page, "第1話 ", "本文 .md 化");
        await waitUntil(async () => (await readdir(session.manuscriptFolder)).includes(MD_NAME), ".md ができる", 30_000).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}（本文フォルダー：${JSON.stringify(await readdir(session.manuscriptFolder))}／窓：${(await dialogText(page)) ?? "なし"}／知らせ：${JSON.stringify(await noticeLines(page))}）`
          );
        });
        const mdPath = path.join(session.manuscriptFolder, MD_NAME);
        let converted = "";
        await waitUntil(
          async () => {
            converted = await readFile(mdPath, "utf8").catch(() => "");
            return converted.includes("{白銀|しろがね}") && converted.includes("{{それ}}");
          },
          ".md の中のルビ・傍点がこの拡張機能の書き方に直る",
          20_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（.md：${JSON.stringify(converted)}）`);
        });
        // 中身が本当に変わったこと（変わっていなければ、このテストは何も確かめていない）
        expect(converted, "元のサイトの書き方が残っている").not.toContain("｜白銀《しろがね》");
        await waitUntil(async () => ((await ledger(session)).posts ?? [])[0]?.episodePath === `本文/${MD_NAME}`, "台帳が .md を指す", 20_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（台帳：${JSON.stringify(await ledger(session))}／知らせ：${JSON.stringify(await noticeLines(page))}）`);
          }
        );
        expect((await ledger(session)).posts?.[0]?.bodyHash, "台帳の印は書き換えない（作者の記録）").toBe(post?.bodyHash);

        /* ── 3. もう一度「新話投稿」：促しは出ず、未投稿の第2話の案内へ進む ── */
        await runCommand(page, "新話投稿");
        const next = await waitTitle(
          page,
          (title) => title.includes("カクヨム"),
          "未投稿の第2話の投稿の案内が出る（促しは出ない）",
          (title) => title.includes(PROMPT_TITLE)
        );
        expect(next, `案内が第2話ではない（題：${next}）`).toContain("第2話");
        expect(((await ledger(session)).posts ?? []).length, "記録は1件のまま").toBe(1);
        await pickQuickPickRow(page, "中止する");
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 10_000);

        /* ── 4. .md の本文を1字直すと、促す ── */
        const raw = await readFile(mdPath, "utf8");
        expect(raw, "直す字が本文に無い").toContain("降っていた");
        await writeFile(mdPath, raw.replace("降っていた", "舞っていた"), "utf8");
        await runCommand(page, "新話投稿");
        await waitTitle(page, (title) => title.includes(PROMPT_TITLE), "1字直したあとの新話投稿で、出し直しの促しが出る");
        const placeHolder = (await quickPickPlaceholder(page)) ?? "";
        expect(placeHolder, "促しの文が違う").toContain("は投稿後に直しています。出し直しますか");
        const rows = (await quickPickRows(page)).map((row) => row.label);
        expect(rows.some((label) => label.includes("第1話") && label.includes("出し直す")), `第1話の出し直しが無い（${JSON.stringify(rows)}）`).toBe(true);
        await page.keyboard.press("Escape");
      } finally {
        await session.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), before).catch(() => undefined);
      }
    },
    LAUNCH
  );
}, 240_000);
