/**
 * 「GitHubと同期」の一覧の文と、どちらの文を残すか選ぶ画面が焦点を外しても閉じないこと
 * （画面の自動テスト、設計書5.5.18・6.113）。実機確認リスト「起動時の点検（0.83.13。B15）」の下の
 * 2項目を、0.105.6（作者の裁定 2026-10-13 夜「案A」）の直しのあとで機械へ移したもの。
 *
 * 何を見張るか：
 * - 【文言】同期のメニューの題・状態の文・項目が作者の選んだ文（案A）どおりで、開発の言葉
 *   （main・分かれています・衝突・退避の枝・未コミット・リモート／ローカル）が画面に出ない。
 *   文の出どころは `src/core/gitSyncMenuText.ts`（単体テスト `gitSyncMenu.test.ts` が文そのものを見る）。
 *   ここで見るのは、本物の git の状態（このPCと GitHub の両方で同じ行を直した）から、その文が
 *   本当に画面に出ること
 * - 【不具合】どちらの文を残すか選ぶ画面（`resolveConflicts.ts` の `reviewConflict`）が、ほかへ焦点が
 *   移っても閉じない（`ignoreFocusOut: true`）。**対照を置く**：同じ焦点の外し方でコマンドパレット
 *   （`ignoreFocusOut` 無し）が閉じることを先に見せる。対照が無いと、焦点を外せていないだけで通る
 *
 * 並びについて：案Aの文中では「両方の書き換えを合わせる」が先頭に書かれているが、製品は
 * 「保存してそろえる」を先頭に置く（作者の報告 2026-10-10。`buildGitSyncMenuEntries` のコメント）。
 * 単体テストの期待する並びに揃えてある。
 *
 * **GitHub は呼ばない。** 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts` の
 * `addLocalRemote`）。「もう1台」はその置き場を clone したフォルダーで、起こしたあとで同じ行を直して送る。
 * 自動の送り直し・自動の取りに行きは切る（そろえる前に勝手に送り・取り込みが走ると、両方で直した
 * 状態が崩れる。作者の記録 2026-10-13 でも、そろえた15秒後に自動の送り直しが送った）。
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { describeNotices } from "./support/noticeRecord";
import { addLocalRemote, git, gitWhileRunning, initRepoWithFirstCommit, porcelainLines } from "./support/gitFixture";
import { runCommand } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  pickQuickPickRow,
  pressDialogButton,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickPickPlaceholder,
  quickPickRows,
  quickPickTitle,
  quickPickWidgetText,
  waitForQuickPick,
} from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const FIRST_LINE = "　一話の本文。";
const THERE_LINE = "　一話の本文（もう1台で直した）。";
const HERE_LINE = "　一話の本文（このPCで直した）。";

const MENU_TITLE = `${E2E_WORK_TITLE} を GitHub とそろえる`;
/** 案Aの状態の文（GitHub から来る分 1件・このPCから送る分 1件・同じ所を直した話 1つ） */
const MENU_STATUS =
  "このPCと GitHub の両方で書き換えがあります（GitHub から来る分 1件・このPCから送る分 1件）。" +
  "同じ所を両方で直した話が 1 つあります";
/** 製品の並び（`gitSyncMenu.test.ts` と同じ） */
const MENU_LABELS = [
  "保存してそろえる（ほかの作品もまとめて）",
  "いまの原稿を履歴に残す（送らない）",
  "両方の書き換えを合わせる",
  "このPCの書き換えだけ送る",
  "GitHub の様子を読み直す（原稿は変えない）",
  "記録を見る",
  "取りやめる",
];
/** 作者が「開発の言葉」と挙げたもの（単体テストの DEV_WORDS と同じ） */
const DEV_WORDS = ["main", "分かれています", "衝突", "退避の枝", "未コミット", "リモート", "ローカル", "コミット"];

const PICK_TITLE = `${EPISODE}：どちらの文を残しますか`;

/**
 * 起こし方：自動の送り直し・取りに行きを切り、置き場・送り先・「もう1台」（送り先の clone）を用意する。
 *
 * **直すのは起こしたあと**（`divergeBothSides`）。起こした時点で GitHub だけが進んでいると、
 * 開いたときの点検が「別の環境だけが進んでいれば取り込む」で先に取り込んでしまい、
 * 両方で直した状態を作れない（package.json の `novelai.git.autoFetch` の説明）
 */
const LAUNCH: LaunchOptions = {
  settings: { "novelai.git.autoResend": false, "novelai.git.autoFetch": false },
  prepareWork: async ({ workFolder }) => {
    const root = path.dirname(path.dirname(workFolder));
    const remote = path.join(root, "送り先.git");
    await initRepoWithFirstCommit(workFolder);
    await addLocalRemote(workFolder, remote);
    const there = path.join(root, "もう1台");
    await git(root, ["clone", "--quiet", remote, there]);
    await git(there, ["config", "user.name", "もう1台"]);
    await git(there, ["config", "user.email", "e2e-there@example.invalid"]);
    await git(there, ["config", "core.autocrlf", "false"]);
  },
};

/**
 * 両方で同じ行を直す（作者の操作ではない準備として、git を直に打つ）：
 * 1. 「もう1台」で直して送る（GitHub から来る分 1件）
 * 2. このPCで別の文に直し、登録の印（`.aiwriter/config.json`・`.gitignore`）と一緒に1回記録する。送らない
 * そのあと、このPCから送る分 1件・GitHub から来る分 1件になっていることを確かめる
 */
async function divergeBothSides(session: E2ESession): Promise<void> {
  const repo = session.workFolder;
  const there = path.join(path.dirname(path.dirname(repo)), "もう1台");
  await writeFile(path.join(there, "本文", EPISODE), `${THERE_LINE}\n`, "utf8");
  await git(there, ["commit", "--quiet", "-am", "もう1台で直した"]);
  await git(there, ["push", "--quiet"]);
  await waitUntil(() => existsSync(path.join(repo, ".aiwriter", "config.json")), "登録の印（config.json）ができる", 30_000);
  // 登録のすぐあとは製品が印を書き足すことがある（librarySyncRecord の registerOther と同じ間）
  await session.page.waitForTimeout(2_500);
  await writeFile(path.join(session.manuscriptFolder, EPISODE), `${HERE_LINE}\n`, "utf8");
  await gitWhileRunning(repo, ["add", "-A"]);
  await gitWhileRunning(repo, ["commit", "--quiet", "-m", "このPCで直した"]);
  await gitWhileRunning(repo, ["fetch", "--quiet"]);
  const counts = (await gitWhileRunning(repo, ["rev-list", "--left-right", "--count", "HEAD...origin/main"])).trim();
  const left = await porcelainLines(repo);
  if (counts.split(/\s+/).join(" ") !== "1 1" || left.length > 0) {
    throw new Error(
      `両方で1件ずつ直した状態になりません（このPC…GitHub の差：${JSON.stringify(counts)}／git status：${JSON.stringify(left)}` +
        `／${await describeNotices(session)}）`
    );
  }
}

/** 「GitHubと同期」をパレットから押し、この作品の一覧が出るまで進む */
async function openSyncMenu(page: Page): Promise<void> {
  await runCommand(page, "GitHubと同期");
  await waitUntil(
    async () => {
      const title = (await quickPickTitle(page)) ?? "";
      return title.includes("同期する作品を選択") || title === MENU_TITLE;
    },
    "同期の選ぶ画面が出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
  });
  if (((await quickPickTitle(page)) ?? "").includes("同期する作品を選択")) await pickQuickPickRow(page, E2E_WORK_TITLE);
  await waitForQuickPick(page, MENU_TITLE, 30_000);
}

/**
 * 選ぶ画面の入力欄から焦点を外す（ほかの窓へ移ったときと同じく、焦点が選ぶ画面の外へ出る）。
 * 画面の中だけの操作で、OS の前面は取らない。テストの窓は `keepOutOfTheWay` で OS の焦点を
 * 持たないので、窓そのものの blur では選ぶ画面に何も届かない
 */
async function blurQuickInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    active?.blur();
  });
}

test("「GitHubと同期」の一覧は、題・状態の文・項目が案Aの文どおりで、開発の言葉が出ない（両方で同じ行を直したとき）", async () => {
  await withVsCode(
    "同期の一覧の文（案A）",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      await divergeBothSides(session);
      await clearNotifications(page);

      await openSyncMenu(page);
      // 状態の文は入力欄の薄い字。一覧を開くときに GitHub の様子を取りに行くので、そのあとの数
      expect(await quickPickPlaceholder(page), "状態の文（案A）").toBe(MENU_STATUS);
      const rows = await quickPickRows(page);
      expect(
        rows.map((row) => row.label),
        `項目の並び（${JSON.stringify(rows)}）`
      ).toEqual(MENU_LABELS);

      // 「両方の書き換えを合わせる」の説明（見出しの行と下の行に分けて出す）
      const widget = await quickPickWidgetText(page);
      expect(widget).toContain("GitHub の書き換えをこのPCへ持ってきて合わせます。");
      expect(widget).toContain("同じ所を直した話は、どちらを残すか選べます。合わせる前の状態は控えておくので、あとで戻せます。");

      // 開発の言葉が、題・行・説明・下の行・状態の文のどこにも出ない
      const screen = `${widget}\n${(await quickPickPlaceholder(page)) ?? ""}`;
      for (const word of DEV_WORDS) {
        expect(screen, `一覧に「${word}」が出る：\n${screen}`).not.toContain(word);
      }

      await page.keyboard.press("Escape");
    },
    LAUNCH
  );
}, 240_000);

test("両方で同じ行を直して「両方の書き換えを合わせる」を選ぶと、どちらの文を残すか選ぶ画面は、焦点を外しても・ほかを押しても閉じない（コマンドパレットは同じ操作で閉じる）", async () => {
  await withVsCode(
    "選ぶ画面は焦点を外しても閉じない",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      await divergeBothSides(session);
      await clearNotifications(page);

      /* ── 対照：ignoreFocusOut の無いコマンドパレットは、同じ操作で閉じる ── */
      await pressWorkbenchKey(page, "Control+Shift+KeyP");
      await waitUntil(async () => (await quickPickTitle(page)) !== undefined || (await page.locator(".quick-input-widget input").first().isVisible()), "コマンドパレットが開く", 10_000);
      await blurQuickInput(page);
      await waitUntil(
        async () => !(await page.locator(".quick-input-widget input").first().isVisible().catch(() => false)),
        "（対照）焦点を外すとコマンドパレットが閉じる",
        5_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}——焦点の外し方が選ぶ画面に届いていない。このテストは何も見張れていない`);
      });

      /* ── 一覧から「両方の書き換えを合わせる」→ 入口の確認の窓［1件ずつ選ぶ］→ 選ぶ画面 ── */
      await openSyncMenu(page);
      await pickQuickPickRow(page, "両方の書き換えを合わせる");
      let confirm: string | undefined;
      await waitUntil(async () => ((confirm = await dialogText(page)) ?? "").includes("同じ箇所を両方で書き換えたもの"), "そろえる入口の確認の窓が出る", 60_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(confirm)}${await quickInputWaitContext(page)}／${await describeNotices(session)}）`);
        }
      );
      await pressDialogButton(page, "1件ずつ選ぶ");
      await waitForQuickPick(page, PICK_TITLE, 30_000);

      const stillOpen = async (): Promise<boolean> => (await quickPickTitle(page)) === PICK_TITLE;

      // 1. 焦点を選ぶ画面の外へ出す（ほかの窓へ移ったとき）
      await blurQuickInput(page);
      await holdsFor(stillOpen, "焦点を外しても、どちらの文を残すか選ぶ画面が出たまま", 4_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
      });

      // 2. 並べて開いた見比べ（左右の文）を押す——作者が読み比べに行くのと同じ
      const diff = page.locator(".monaco-diff-editor .editor.modified .view-lines").first();
      await diff.waitFor({ state: "visible", timeout: 15_000 }).catch(async (error: unknown) => {
        throw new Error(`見比べの画面が出ません（${String(error)}）${await quickInputWaitContext(page)}`);
      });
      await diff.click();
      await holdsFor(stillOpen, "見比べの画面を押しても、どちらの文を残すか選ぶ画面が出たまま", 4_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
      });

      // 選ぶ画面は閉じていないので、原稿はまだ何も変わっていない（合わせる途中）
      const rows = await quickPickRows(page);
      expect(rows.some((row) => row.label.includes("左の文を残す")), `選ぶ画面の行（${JSON.stringify(rows)}）`).toBe(true);
    },
    LAUNCH
  );
}, 240_000);
