/**
 * 記録と同期のあと、「未記録」「記録待ち」の数が0に戻って戻らない（画面の自動テスト、設計書5.5.19・
 * 6.15.1・6.113。実機確認リスト 80・88・4989 を、仕分け 2026-10-12 の束 E4 として移した。
 * 作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 何を見張るか：
 * - 80：書庫（1つの置き場に作品が2つ）で書き換えて右下（ステータスバー）に「未記録 N」を出し、
 *   ステータスバーを押して「いまの原稿を履歴に残す」、または「全作品同期」を押したあと、`git status` が0件なら
 *   「未記録」が消え、数秒待っても戻らない。「GitHub の様子を読み直す」の知らせの数とステータスバーの数が
 *   食い違わない（一覧の文は 0.105.6 で作者の裁定「案A」に改めた。2026-10-13 夜）
 * - 4989：記録だけ（送らない）を押すと、作品一覧の「記録待ち」の数が減る（0になる）
 * - 88：原稿エディターで話に字を足し、保存しないうちに「全作品同期」を押すと、確認の窓に
 *   「記録（未保存 1件を先に保存）」と出て、同期のあと「未記録」が0のまま戻らない。ほかの作品
 *   （git で管理していない作品）で開いている未保存の文書は、保存されずに残る
 *
 * **GitHub は呼ばない。** 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts` の
 * `addLocalRemote`）で、送信も手元のフォルダーどうしで済む。
 *
 * 「保存される前に（自動保存の待ちのうちに）」は、画面の自動テストの設定が自動保存を切っている
 * （`files.autoSave: off`。`support/vscodeApp.ts`）ので、打ったあと保存しないだけで作れる。
 *
 * 作品を登録すると、製品が作品の印（`.aiwriter/config.json`・`.gitignore`）を書くので、起こした直後は
 * それが「未記録」に数えられる。テストは登録のあとでその分を記録・送信してから（作者の操作ではない
 * 準備として、git を直に打つ）、数え始める。
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { describeNotices, waitForNotice } from "./support/noticeRecord";
import { addLocalRemote, gitWhileRunning, initRepoWithFirstCommit, porcelainLines } from "./support/gitFixture";
import { runCommand, waitForQuickInput, waitQuickInputClosed } from "./support/quickInput";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  pickQuickPickRow,
  pressDialogButton,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickPickTitle,
  statusBarTexts,
  tabIsDirty,
} from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const FIRST_LINE = "　一話の本文。";
/**
 * もう1つの作品。**題は英字で始める**——登録簿は題の順に並び（`core/workRegistry.ts`）、どちらが
 * 置き場の代表になっても通るように書いてあるが、名前で探すときに取り違えないよう短い英字の頭にする
 */
const OTHER_TITLE = "B 隣の作品";
const OTHER_EPISODE = "001_となり.txt";
const OTHER_FIRST_LINE = "　隣の作品の本文。";

const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";
const SHOW_SIDEBAR_PRESS = "Control+Alt+Shift+KeyJ";

/** 起こし方：左の列（作品一覧）を出すキーと、もう1つの作品を登録するキー。`prepare` は作品と git の準備 */
function launchFor(prepare: (folders: { workFolder: string; otherFolder: string; root: string }) => Promise<void>): LaunchOptions {
  const registerOther: Record<string, unknown> = {
    key: REGISTER_OTHER_KEY,
    command: "novelai.addWork",
    args: { folderPath: "", title: OTHER_TITLE },
  };
  return {
    settings: { ...SIDEBAR_LAUNCH.settings },
    keybindings: [...SIDEBAR_LAUNCH.keybindings, registerOther],
    prepareWork: async ({ workFolder }) => {
      const library = path.dirname(workFolder);
      const otherFolder = path.join(library, OTHER_TITLE);
      await mkdir(path.join(otherFolder, "本文"), { recursive: true });
      await writeFile(path.join(otherFolder, "本文", OTHER_EPISODE), `${OTHER_FIRST_LINE}\n`, "utf8");
      // keybindings.json はこの準備のあとに書かれるので、置き場の道はここで args へ入れる
      registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
      await prepare({ workFolder, otherFolder, root: path.dirname(library) });
    },
  };
}

function otherFolderOf(session: E2ESession): string {
  return path.join(path.dirname(session.workFolder), OTHER_TITLE);
}

/** もう1つの作品を登録する（作品の印ができるまで押し直す。同じ場所の二重の登録は製品が断る） */
async function registerOther(session: E2ESession): Promise<void> {
  const { page } = session;
  const config = path.join(otherFolderOf(session), ".aiwriter", "config.json");
  const until = Date.now() + 60_000;
  for (;;) {
    await pressWorkbenchKey(page, REGISTER_OTHER_PRESS);
    const done = await waitUntil(() => existsSync(config), `${config} ができる`, 5_000)
      .then(() => true)
      .catch(() => false);
    if (done) break;
    if (Date.now() > until) throw new Error(`「${OTHER_TITLE}」を登録できません（${await describeNotices(session)}）`);
  }
  await page.waitForTimeout(2_500);
  await clearNotifications(page);
}

/** 登録で増えた作品の印を記録して送り、`git status` が空の状態から始める（作者の操作ではない準備） */
async function settleBaseline(repo: string): Promise<void> {
  await gitWhileRunning(repo, ["add", "-A"]);
  // 執筆量の記録だけでも記録する（製品は数えないが、記録には入れる。ここで残すと後の差に混ざる）
  if ((await gitWhileRunning(repo, ["status", "--porcelain"])).trim() !== "") {
    await gitWhileRunning(repo, ["commit", "--quiet", "-m", "作品の登録の印"]);
  }
  await gitWhileRunning(repo, ["push", "--quiet"]);
  const left = await porcelainLines(repo);
  if (left.length > 0) throw new Error(`準備の記録のあとも git status が空になりません：${JSON.stringify(left)}`);
}

/** ステータスバーの同期の項目に出ている数（「未記録 2 / 未送信 1」の `label` の数。無ければ 0） */
async function statusBarCount(page: Page, label: "未記録" | "未送信"): Promise<number> {
  for (const text of await statusBarTexts(page)) {
    const match = new RegExp(`${label}\\s*(\\d+)`).exec(text);
    if (match) return Number(match[1]);
  }
  return 0;
}

/** 作品一覧の作品の行（印が付くと名前の頭が変わるので、題を含む・開閉の印を持つ行で探す） */
function workRow(page: Page, title: string) {
  return page.locator(`.monaco-list-row[aria-expanded][aria-label*="${title}"]`).first();
}

/** 作品一覧の行の「記録待ち N」の数（印が無ければ 0） */
async function rowPending(page: Page, title: string): Promise<number> {
  const label = (await workRow(page, title).getAttribute("aria-label").catch(() => null)) ?? "";
  const match = /記録待ち\s*(\d+)/.exec(label);
  return match ? Number(match[1]) : 0;
}

async function showSidebar(session: E2ESession, titles: readonly string[]): Promise<void> {
  const { page } = session;
  // 起こしたとき既に印が付いていると、行の名前が題で始まらない（sidebar.ts の showSidebar は使えない）
  await pressWorkbenchKey(page, SHOW_SIDEBAR_PRESS);
  for (const title of titles) {
    await waitUntil(async () => (await workRow(page, title).count()) > 0, `作品一覧に「${title}」の行が出る`, 30_000);
  }
}

/** 様子（落ちたときの文に添える）：ステータスバー・作品一覧の行・git status・知らせ */
async function describeSync(session: E2ESession, repo: string, titles: readonly string[]): Promise<string> {
  const { page } = session;
  const rows: string[] = [];
  for (const title of titles) rows.push((await workRow(page, title).getAttribute("aria-label").catch(() => null)) ?? `（${title}の行なし）`);
  return (
    `ステータスバー：${JSON.stringify(await statusBarTexts(page))}／作品一覧：${JSON.stringify(rows)}` +
    `／git status：${JSON.stringify(await porcelainLines(repo).catch((error: unknown) => [String(error)]))}` +
    `／${await describeNotices(session)}`
  );
}

/** ステータスバーの同期の項目（`hasText` の字を含むもの）を押し、置き場の同期の選ぶ画面まで進む */
async function openSyncMenuFromStatusBar(page: Page, hasText: string): Promise<void> {
  const item = page.locator(".part.statusbar .statusbar-item", { hasText }).first();
  await item.waitFor({ state: "visible", timeout: 10_000 }).catch(async (error: unknown) => {
    throw new Error(`ステータスバーに「${hasText}」の項目が出ません（${String(error)}／${JSON.stringify(await statusBarTexts(page))}）`);
  });
  await item.click();
  // 手当ての要る置き場が1つなら、その置き場の「<作品> を GitHub とそろえる」が直に出る（`buildStatusBarSyncMenu`）。
  // 2つ以上なら「GitHubとの同期」から置き場（書庫）の行を選ぶ
  await waitUntil(
    async () => {
      const title = (await quickPickTitle(page)) ?? "";
      return title.includes("を GitHub とそろえる") || title === "GitHubとの同期";
    },
    "ステータスバーを押すと同期の選ぶ画面が出る",
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
  });
  if ((await quickPickTitle(page)) === "GitHubとの同期") {
    await pickQuickPickRow(page, "書庫");
    await waitForQuickInput(page, "を GitHub とそろえる");
  }
}

/** ステータスバーから「GitHub の様子を読み直す」を押し、知らせの文を返す */
async function checkStatus(session: E2ESession, hasText: string): Promise<string> {
  const { page } = session;
  const since = Date.now();
  await openSyncMenuFromStatusBar(page, hasText);
  await pickQuickPickRow(page, "GitHub の様子を読み直す");
  // 知らせは「<作品>：<状態の文>。」（`describeSyncMenuStatus`）
  return waitForNotice(
    session,
    (message) => /：(このPC|GitHub に|履歴に残していない)/.test(message),
    "「GitHub の様子を読み直す」の知らせ",
    { since, timeoutMs: 30_000 }
  );
}

test("書庫で書き換えると「未記録」が置き場の数で出て、「状態を確認」の知らせと数が合い、記録だけで作品一覧の「記録待ち」が0になり、全作品同期のあとも「未記録」が戻らない", async () => {
  await withVsCode(
    "書庫の記録と同期",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      const library = path.dirname(session.workFolder);
      const titles = [E2E_WORK_TITLE, OTHER_TITLE];
      await registerOther(session);
      await settleBaseline(library);
      await showSidebar(session, titles);

      /* ── 2つの作品の本文を書き換える（外から足す）→ 置き場の数で「未記録 2」 ── */
      await appendFile(path.join(session.manuscriptFolder, EPISODE), "足した一行。\n", "utf8");
      await appendFile(path.join(otherFolderOf(session), "本文", OTHER_EPISODE), "隣に足した一行。\n", "utf8");
      await waitUntil(
        async () =>
          (await statusBarCount(page, "未記録")) === 2 &&
          (await rowPending(page, E2E_WORK_TITLE)) === 1 &&
          (await rowPending(page, OTHER_TITLE)) === 1,
        "ステータスバーが「未記録 2」（置き場の数）、作品一覧の2つの行が「記録待ち1」になる",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeSync(session, library, titles)}）`);
      });
      expect(await porcelainLines(library), "git status の行の数とステータスバーの数が同じ").toHaveLength(2);

      /* ── 80：「GitHub の様子を読み直す」の知らせとステータスバーの数が食い違わない ── */
      const dirtyNotice = await checkStatus(session, "未記録");
      expect(dirtyNotice, `「GitHub の様子を読み直す」の知らせ（${await describeSync(session, library, titles)}）`).toContain(
        "履歴に残していない書き換えが 2件あります"
      );
      expect(await statusBarCount(page, "未記録"), "確認のあともステータスバーは「未記録 2」").toBe(2);
      await clearNotifications(page);

      /* ── 4989・80：ステータスバーから「いまの原稿を履歴に残す（送らない）」→ 記録待ちが0に ── */
      const recordSince = Date.now();
      await openSyncMenuFromStatusBar(page, "未記録");
      await pickQuickPickRow(page, "いまの原稿を履歴に残す");
      await waitForQuickInput(page, "この記録に付ける説明");
      await page.keyboard.press("Enter");
      await waitQuickInputClosed(page, "記録の説明の入力欄が閉じる");
      await waitForNotice(session, (message) => message.includes("件の変更を記録しました"), "記録した知らせ", { since: recordSince });
      expect(await porcelainLines(library), "記録のあと git status は空").toEqual([]);
      await waitUntil(
        async () =>
          (await statusBarCount(page, "未記録")) === 0 &&
          (await rowPending(page, E2E_WORK_TITLE)) === 0 &&
          (await rowPending(page, OTHER_TITLE)) === 0,
        "記録のあと、ステータスバーの「未記録」と作品一覧の「記録待ち」が消える",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeSync(session, library, titles)}）`);
      });
      // 数秒待っても戻らない（記録の途中の古い読みが後から返って、数を書き戻さない）
      await holdsFor(
        async () =>
          (await statusBarCount(page, "未記録")) === 0 &&
          (await rowPending(page, E2E_WORK_TITLE)) === 0 &&
          (await rowPending(page, OTHER_TITLE)) === 0,
        "記録のあと「未記録」「記録待ち」が0のまま",
        6_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeSync(session, library, titles)}）`);
      });

      // 記録しただけで送っていないので「未送信 1」。「GitHub の様子を読み直す」の知らせも同じ数
      await waitUntil(async () => (await statusBarCount(page, "未送信")) === 1, "ステータスバーが「未送信 1」になる", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（${await describeSync(session, library, titles)}）`);
        }
      );
      const aheadNotice = await checkStatus(session, "未送信");
      expect(aheadNotice).toContain("GitHub へまだ送っていない書き換えが 1件あります");
      expect(aheadNotice, "記録のあとの「GitHub の様子を読み直す」に履歴に残していない書き換えが出ない").not.toContain(
        "履歴に残していない"
      );
      await clearNotifications(page);

      /* ── 80：もう一度書き換えて「全作品同期」→ 記録して送り、「未記録」も「未送信」も戻らない ── */
      await appendFile(path.join(session.manuscriptFolder, EPISODE), "もう一行。\n", "utf8");
      await waitUntil(async () => (await statusBarCount(page, "未記録")) === 1, "ステータスバーが「未記録 1」になる", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（${await describeSync(session, library, titles)}）`);
        }
      );
      const syncSince = Date.now();
      await runCommand(page, "全作品同期");
      let confirm: string | undefined;
      await waitUntil(async () => ((confirm = await dialogText(page)) ?? "").includes("か所を同期します"), "全作品同期の確認の窓が出る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(confirm)}／${await describeNotices(session, syncSince)}）`);
        }
      );
      expect(confirm).toContain("1か所を同期します。");
      expect(confirm).toContain("1か所はGitHubへ送信します。");
      await pressDialogButton(page, "同期する");
      await waitUntil(
        async () =>
          (await porcelainLines(library)).length === 0 &&
          (await gitWhileRunning(library, ["rev-parse", "HEAD"])) === (await gitWhileRunning(library, ["rev-parse", "origin/main"])),
        "全作品同期のあと、git status が空で、送り先と同じところまで送ってある",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeSync(session, library, titles)}）`);
      });
      await waitUntil(
        async () => (await statusBarCount(page, "未記録")) === 0 && (await statusBarCount(page, "未送信")) === 0,
        "全作品同期のあと、ステータスバーの「未記録」「未送信」が消える",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeSync(session, library, titles)}）`);
      });
      await holdsFor(
        async () =>
          (await statusBarCount(page, "未記録")) === 0 &&
          (await statusBarCount(page, "未送信")) === 0 &&
          (await rowPending(page, E2E_WORK_TITLE)) === 0,
        "全作品同期のあと「未記録」が0のまま戻らない",
        6_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeSync(session, library, titles)}）`);
      });
    },
    launchFor(async ({ root }) => {
      // 書庫そのものを1つの置き場にする（作品2つが同じ git に入る）
      const library = path.join(root, "書庫");
      await initRepoWithFirstCommit(library);
      await addLocalRemote(library, path.join(root, "送り先.git"));
    })
  );
}, 300_000);

test("原稿エディターで打って保存しないうちに全作品同期を押すと、確認に「記録（未保存 1件を先に保存）」と出て、保存して記録・送信し、未記録は0のまま。git の無い作品の未保存は残る", async () => {
  await withVsCode(
    "未保存のまま全作品同期",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      const repo = session.workFolder;
      const titles = [E2E_WORK_TITLE, OTHER_TITLE];
      await registerOther(session);
      await settleBaseline(repo);
      await showSidebar(session, titles);

      // git の無い作品の話にも打って、未保存にしておく（この作品は同期の相手ではない）
      const otherFrame = await openEpisode(page, OTHER_EPISODE, "隣の作品の本文");
      await placeCaretAfter(otherFrame, OTHER_FIRST_LINE);
      await page.keyboard.insertText("隣で打った字");
      await waitUntil(async () => await tabIsDirty(page, OTHER_EPISODE), "git の無い作品の話が未保存になる", 15_000);

      // 同期する作品の話に打つ（保存しない）
      const frame = await openEpisode(page, EPISODE, "一話の本文");
      await placeCaretAfter(frame, FIRST_LINE);
      await page.keyboard.insertText("同期の前に打った字");
      await waitUntil(async () => (await composeText(frame)).includes("同期の前に打った字"), "打った字が画面に出る");
      await waitUntil(async () => await tabIsDirty(page, EPISODE), "同期する作品の話が未保存になる", 15_000);
      expect(await porcelainLines(repo), "保存していないので、ディスクはまだ変わっていない").toEqual([]);

      const since = Date.now();
      await runCommand(page, "全作品同期");
      let confirm: string | undefined;
      await waitUntil(async () => ((confirm = await dialogText(page)) ?? "").includes("か所を同期します"), "全作品同期の確認の窓が出る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(confirm)}／${await describeNotices(session, since)}）`);
        }
      );
      expect(confirm).toContain("1か所を同期します。");
      /*
        保存してから記録することが、押す前に見える。ディスクの件数が0なら「記録（未保存 1件を先に保存）」、
        執筆量の記録（`.aiwriter/stats/`）が開いただけで書き換わっていれば「記録 1件（未保存 1件を先に保存）」
        になる（`core/syncAllPlan.ts` の `describePlan`。記録できる件数〔`countTrackableFiles`〕は執筆量の
        記録も数える）。見たいのは「未保存 1件を先に保存」が見えることで、件数ではない
      */
      expect(confirm ?? "", "保存してから記録することが、押す前に見える").toMatch(
        new RegExp(`・${E2E_WORK_TITLE}：記録( \\d+件)?（未保存 1件を先に保存）`)
      );
      // git の無い作品は同期の相手に入らず、「次は同期しません」の側に理由つきで並ぶ
      expect(confirm).toContain(`・${OTHER_TITLE}：Gitで管理していません`);
      await pressDialogButton(page, "同期する");

      // 保存して記録・送信した：ファイルに字が入り、git status が空で、送り先と同じところまで送ってある
      await waitUntil(
        async () =>
          (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).includes("同期の前に打った字") &&
          (await porcelainLines(repo)).length === 0 &&
          (await gitWhileRunning(repo, ["rev-parse", "HEAD"])) === (await gitWhileRunning(repo, ["rev-parse", "origin/main"])),
        "同期のあと、打った字がファイルに入り、記録して送ってある",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeSync(session, repo, titles)}）`);
      });
      expect(await tabIsDirty(page, EPISODE), "同期した話は保存済み").toBe(false);
      expect((await gitWhileRunning(repo, ["log", "-1", "-p", "--format=%s"])).includes("同期の前に打った字"), "最後の記録に打った字が入っている").toBe(true);

      /*
        **送り終わった（git が揃った）ことは、全作品同期が終わったことではない。** 送ったあとも同期は
        「作品を同期しています…」のまま後片づけを続け、そのあいだステータスバーと作品一覧には、記録の
        直前に読んだ「未記録 2／記録待ち2」（話と執筆量の記録）が残っている。ここで見張りを始めると、
        戻ったのではなく**まだ下りていない数**を拾って落ちる（2026-10-15、0.107.3 でも 5回中3回落ちた）。
        1件目と同じく、終わった知らせと数が0になるのを待ってから「戻らない」を見る
      */
      await waitForNotice(session, (message) => message.includes("を済ませました"), "全作品同期が済んだ知らせ", { since, timeoutMs: 60_000 });
      await waitUntil(
        async () => (await statusBarCount(page, "未記録")) === 0 && (await rowPending(page, E2E_WORK_TITLE)) === 0,
        "全作品同期のあと、ステータスバーの「未記録」と作品一覧の「記録待ち」が消える",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeSync(session, repo, titles)}）`);
      });

      // 「未記録」が0のまま戻らない（保存のあとの書き込みで、また記録待ちにならない）
      await holdsFor(
        async () =>
          (await statusBarCount(page, "未記録")) === 0 &&
          (await rowPending(page, E2E_WORK_TITLE)) === 0 &&
          (await porcelainLines(repo)).length === 0,
        "同期のあと「未記録」が0のまま戻らない",
        6_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeSync(session, repo, titles)}）`);
      });

      // git の無い作品の未保存は、保存されずに残る
      expect(await tabIsDirty(page, OTHER_EPISODE), "git の無い作品の話は未保存のまま").toBe(true);
      expect(
        (await readFile(path.join(otherFolderOf(session), "本文", OTHER_EPISODE), "utf8")).replace(/\r\n/g, "\n"),
        "git の無い作品のファイルは書き換わらない"
      ).toBe(`${OTHER_FIRST_LINE}\n`);
    },
    launchFor(async ({ workFolder, root }) => {
      // 作品フォルダーだけを置き場にする（隣の作品は git の外）
      await initRepoWithFirstCommit(workFolder);
      await addLocalRemote(workFolder, path.join(root, "送り先.git"));
    })
  );
}, 300_000);
