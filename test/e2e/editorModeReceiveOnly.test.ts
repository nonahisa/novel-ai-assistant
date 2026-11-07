/**
 * 編集者モードの「保存・同期」は受け取るだけ（画面の自動テスト、設計書5.6・5.6.6・6.113。
 * 実機確認リスト 338行〔0.121.0〕「編集者モード（kmizu さんの環境）で、簡単ステップメニュー
 * 「1. 編集者として参加」に「保存・同期」が出る。作者が原稿を直して送ったあとに押すと、確認の窓が
 * 「N か所で、作者の最新の原稿を受け取ります」・ボタン［受け取る］で、押すと受け取るだけで GitHub へは
 * 何も送らない（提案の書きかけはそのまま残る）。校閲の範囲を押さえたときの知らせ…」を機械へ移した。
 * 作者の判断 2026-11-01「編集者モードの保存・同期は受け取るだけ」）。
 *
 * **項目の「簡単ステップメニュー「1. 編集者として参加」」は、2026-11-05 夜から編集者メニューの
 * 「1. 作者の最新の原稿を受け取る」になった**（設計書5.6.6。編集者モードでは簡単ステップメニューを出さない。
 * 行を押すと「保存・同期」が走る——`core/stepDefs.ts` の `EDITOR_STEP_DEFS`）。ここではいまの形で押す。
 *
 * 見張ること：
 * 1. 作者の側が原稿を直して送ったあと、編集者メニューの「1. 作者の最新の原稿を受け取る」を押すと、
 *    確認の窓が「1か所で、作者の最新の原稿を受け取ります。」で、詳しくに「受け取るだけで、GitHubへは
 *    何も送りません。」と「提案は「校閲を終えて返す」で作者へ届きます。」が並び、製品のボタンは［受け取る］だけ
 * 2. ［受け取る］で、作者の直した原稿が手元に入り、手元の記録は作者の側と同じになる（送り先の記録は
 *    作者が送ったときのまま＝こちらからは何も送っていない）。置いてまだ返していない提案（書きかけ）は台帳に残る
 * 3. 続けて「2. 校閲する話を選ぶ」で範囲を押さえると、「…を校閲中にしました。」が出て、
 *    「同期すると届きます」のような作者モードの言い方は出ない。鍵は送り先へ届く
 *
 * **項目の「校閲の範囲を押さえたときの知らせが「「校閲を終えて返す」で作者へ届きます。」」は、いまの製品では
 * 範囲の押さえ（`features/reviewProposals.ts` の `startRangeReview`）の知らせではなく、上の確認の窓の詳しくと、
 * 「修正を提案する」の済んだ知らせ（`features/handProposal.ts`）に出る。** 編集者モードの「校閲開始／終了」は
 * 押さえていなければ必ず範囲の選択へ進むので、1話を押さえたときの「…を押さえました。「校閲を終えて返す」で
 * 作者へ届きます。」へは届かない。ここでは確認の窓の詳しくで文を見て、範囲の知らせは製品のいまの文で見る
 * （食い違いは報告に書いた）。
 *
 * **GitHub は呼ばない。** 作品フォルダー（編集用リポジトリの写し）を本物の git の置き場にし、送り先は
 * 同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts` の `addLocalRemote`）、「作者の側」はそれを
 * clone したフォルダー（`editorModeSaveSyncDiverged` と同じ形）。写しの印（`.aiwriter/editor-share-manifest.json`）と
 * 作者の環境で整えた `.gitignore` を置く（`editorMenuFlow` と同じ）。作者の側の送信は**起こしたあと**に作る
 * （起こした時点で遅れていると、開いたときの点検が先に取り込む）。自動の送り直し・自動の取りに行きは切る。
 * **AI は呼ばない。**
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { HAND_EDIT_CATEGORY, proposalId } from "../../src/models/proposal";
import { describeNotices } from "./support/noticeRecord";
import { addLocalRemote, git, gitWhileRunning, initRepoWithFirstCommit } from "./support/gitFixture";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  notificationTexts,
  pickQuickPickRow,
  pressDialogButton,
  pressWorkbenchKey,
  quickInputWaitContext,
  statusBarTexts,
  waitForQuickPick,
} from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const LINE = "　終電を逃した駅のホームに、雨の音だけが残っていた。";
const AUTHOR_LINE = "　終電を逃した駅のホームに、雨の音だけが響いていた。";
const FILE = `本文/${EPISODE}`;
const PANE = "編集者メニュー";
const RECEIVE_STEP = "1. 作者の最新の原稿を受け取る";
const RANGE_STEP = "2. 校閲する話を選ぶ";
const LEDGER_RELATIVE = path.join(".aiwriter", "proposals", "proposals.jsonl");

/** 作者の環境で整えられた `.gitignore` の行（`editorMenuFlow.test.ts` と同じ見本。`workRegistry.ts` の `IGNORED_PATHS` の写し） */
const AUTHOR_GITIGNORE = [
  ".aiwriter/cache/",
  ".aiwriter/logs/",
  ".aiwriter/exports/",
  ".aiwriter/generated/",
  ".aiwriter/reports/",
  ".aiwriter/external-access.json",
  ".aiwriter/history/spotlight.jsonl",
  ".aiwriter/ai-instruction-usage.json",
  ".novelai-recovery/",
  "exports/",
];

/** 前の回に返して、作者の側にも届いている提案（台帳に記録済み） */
const RETURNED = {
  kind: "proposal",
  id: proposalId(FILE, 1, "終電", `最終電車\u0000前の回に返した直し`),
  time: "2026-11-01T09:00:00.000Z",
  proposer: "画面テスト編集者",
  file: FILE,
  line: 1,
  original: LINE,
  target: "終電",
  suggestion: "最終電車",
  reason: "前の回に返した直し",
  category: HAND_EDIT_CATEGORY,
};

/** この回に置いて、まだ返していない提案（書きかけ。記録していない） */
const DRAFT = {
  ...RETURNED,
  id: proposalId(FILE, 1, "雨の音", `雨音\u0000書きかけの提案の理由`),
  time: "2026-11-02T09:00:00.000Z",
  target: "雨の音",
  suggestion: "雨音",
  reason: "書きかけの提案の理由",
};

function places(root: string): { remote: string; author: string } {
  return { remote: path.join(root, "送り先.git"), author: path.join(root, "作者の機械") };
}

const LAUNCH: LaunchOptions = {
  settings: {
    ...SIDEBAR_LAUNCH.settings,
    "novelai.mode": "editor",
    "novelai.git.autoResend": false,
    "novelai.git.autoFetch": false,
    "workbench.editorAssociations": { "*.txt": "default", "*.md": "default" },
  },
  keybindings: SIDEBAR_LAUNCH.keybindings,
  prepareWork: async ({ workFolder }) => {
    const root = path.dirname(path.dirname(workFolder));
    const { remote, author } = places(root);
    await mkdir(path.join(workFolder, ".aiwriter", "proposals"), { recursive: true });
    await writeFile(path.join(workFolder, ".aiwriter", "editor-share-manifest.json"), "{}\n", "utf8");
    await writeFile(path.join(workFolder, ".gitignore"), `${AUTHOR_GITIGNORE.join("\n")}\n`, "utf8");
    await writeFile(path.join(workFolder, LEDGER_RELATIVE), `${JSON.stringify(RETURNED)}\n`, "utf8");
    await initRepoWithFirstCommit(workFolder);
    await addLocalRemote(workFolder, remote);
    await git(root, ["clone", "--quiet", remote, author]);
    await git(author, ["config", "user.name", "作者"]);
    await git(author, ["config", "user.email", "e2e-author@example.invalid"]);
    await git(author, ["config", "core.autocrlf", "false"]);
  },
};

/** 編集者メニューの行（名前と説明）を並びの順に（`editorMenuFlow.test.ts` と同じ読み方） */
async function menuRows(page: Page): Promise<Array<{ label: string; description: string }>> {
  return page.evaluate((title) => {
    const pane = Array.from(document.querySelectorAll(".pane")).find((node) =>
      (node.querySelector(".pane-header")?.textContent ?? "").includes(title)
    );
    if (!pane) return [];
    return Array.from(pane.querySelectorAll(".monaco-list-row"))
      .sort((a, b) => Number((a as HTMLElement).dataset.index) - Number((b as HTMLElement).dataset.index))
      .map((row) => ({
        label: (row.querySelector(".label-name")?.textContent ?? "").trim(),
        description: (row.querySelector(".label-description")?.textContent ?? "").trim(),
      }));
  }, PANE);
}

async function clickMenuRow(page: Page, label: string): Promise<void> {
  const row = page
    .locator(".pane", { has: page.locator(".pane-header", { hasText: PANE }) })
    .locator(".monaco-list-row", { has: page.locator(".label-name", { hasText: label }) })
    .first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
}

/** 見出しの左端（畳みの矢印）を押して畳む（`editorMenuFlow.test.ts` と同じ押し方） */
async function collapsePane(page: Page, title: string): Promise<void> {
  const header = page.locator(".pane-header", { hasText: title }).first();
  if ((await header.count()) === 0) return;
  const expanded = async () => (await header.getAttribute("aria-expanded")) === "true";
  if (!(await expanded())) return;
  await header.click({ position: { x: 8, y: 10 } });
  await waitUntil(async () => !(await expanded()), `左の列の「${title}」が畳まれる`, 5_000);
}

async function headOf(folder: string, ref = "HEAD"): Promise<string> {
  return (await gitWhileRunning(folder, ["rev-parse", ref])).trim();
}

async function remoteHead(session: E2ESession): Promise<string> {
  const { remote } = places(session.root);
  return (await git(session.root, [`--git-dir=${remote}`, "rev-parse", "main"])).trim();
}

/** 確認の窓（モーダル）の製品のボタン。VS Code が足す［キャンセル］は除く */
async function dialogButtons(page: Page): Promise<string[]> {
  return (await page.locator(".monaco-dialog-box .monaco-button").allInnerTexts())
    .map((text) => text.trim())
    .filter((text) => text !== "" && text !== "Cancel" && text !== "キャンセル");
}

test("編集者メニューの「1. 作者の最新の原稿を受け取る」は、確認の窓［受け取る］で作者の原稿を受け取るだけで何も送らず、書きかけの提案は残り、続けて範囲を押さえると「校閲中にしました」が出る", async () => {
  await withVsCode(
    "編集者モードの受け取るだけの同期",
    [{ name: EPISODE, text: `${LINE}\n` }],
    async (session) => {
      const { page, workFolder, root } = session;
      const { author } = places(root);
      await waitUntil(() => existsSync(path.join(workFolder, ".aiwriter", "config.json")), "作品の登録の印（config.json）ができる", 30_000);
      // 登録のすぐあとは製品が印を書き足すことがある（editorModeSaveSyncDiverged と同じ間）
      await page.waitForTimeout(2_500);

      await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
      await waitUntil(async () => (await menuRows(page)).some((row) => row.label === `作品：${E2E_WORK_TITLE}`), "編集者メニューに作品の行が出る", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（編集者メニューの行：${JSON.stringify(await menuRows(page))}）`);
        }
      );
      for (const other of ["AIに相談", "詳細メニュー", "作品一覧"]) await collapsePane(page, other);

      /* ── 編集者の側：この回の提案を台帳に置く（書きかけ。記録しない） ── */
      const ledger = path.join(workFolder, LEDGER_RELATIVE);
      await appendFile(ledger, `${JSON.stringify(DRAFT)}\n`, "utf8");

      /* ── 作者の側：原稿を直して送る ── */
      await writeFile(path.join(author, "本文", EPISODE), `${AUTHOR_LINE}\n`, "utf8");
      await git(author, ["commit", "--quiet", "-am", "作者が直した"]);
      await git(author, ["push", "--quiet"]);
      const authorHead = await headOf(author);
      const sentBefore = await remoteHead(session);
      expect(sentBefore, "作者の送信が送り先に届いていません").toBe(authorHead);
      const editorBefore = await headOf(workFolder);
      expect(editorBefore, "準備の段で、手元がもう作者の側と同じになっています").not.toBe(authorHead);
      await clearNotifications(page);

      /* ── 1. 「1. 作者の最新の原稿を受け取る」→ 確認の窓 ── */
      await waitUntil(async () => (await menuRows(page)).some((row) => row.label === RECEIVE_STEP), `編集者メニューに「${RECEIVE_STEP}」が並ぶ`, 20_000);
      await clickMenuRow(page, RECEIVE_STEP);
      let dialog = "";
      await waitUntil(async () => (dialog = (await dialogText(page)) ?? "").includes("作者の最新の原稿を受け取ります"), "受け取りの確認の窓が出る", 60_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（窓：${JSON.stringify(dialog)}／知らせ：${JSON.stringify(await notificationTexts(page))}／${await describeNotices(session)}）${await quickInputWaitContext(page)}`);
        }
      );
      const oneLine = dialog.replace(/\s+/g, " ");
      expect(oneLine, `窓の文：${oneLine}`).toContain("1か所で、作者の最新の原稿を受け取ります。");
      expect(oneLine, `窓の文：${oneLine}`).toContain("受け取るだけで、GitHubへは何も送りません。");
      expect(oneLine, `窓の文：${oneLine}`).toContain("提案は「校閲を終えて返す」で作者へ届きます。");
      expect(await dialogButtons(page), `窓の文：${oneLine}`).toEqual(["受け取る"]);

      /* ── 2. ［受け取る］→ 受け取るだけ ── */
      await pressDialogButton(page, "受け取る");
      const manuscript = path.join(session.manuscriptFolder, EPISODE);
      await waitUntil(async () => (await readFile(manuscript, "utf8")).replace(/\r\n/g, "\n") === `${AUTHOR_LINE}\n`, "作者の直した原稿が手元に入る", 60_000).catch(
        async (error: unknown) => {
          throw new Error(
            `${String(error)}（本文：${JSON.stringify(await readFile(manuscript, "utf8").catch(() => "読めない"))}／知らせ：${JSON.stringify(await notificationTexts(page))}／窓：${JSON.stringify(await dialogText(page))}）`
          );
        }
      );
      await waitUntil(async () => (await headOf(workFolder)) === authorHead, "手元の記録が作者の側と同じになる（早送り）", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（手元：${await headOf(workFolder)}／作者の側：${authorHead}／状態：${await gitWhileRunning(workFolder, ["status", "--short"])}）`);
      });
      // こちらからは何も送らない：送り先の記録は作者が送ったときのまま、手元にも送っていない記録は無い
      await holdsFor(async () => (await remoteHead(session)) === sentBefore, "受け取ったあと、送り先の記録が動かない", 3_000);
      expect(await headOf(workFolder), "受け取るだけの環境で、手元に新しい記録ができました").toBe(authorHead);
      // 書きかけの提案は台帳に残っている（記録もされていない）
      const ledgerText = await readFile(ledger, "utf8");
      expect(ledgerText, "書きかけの提案が台帳から消えました").toContain(DRAFT.reason);
      expect(ledgerText, "前の回に返した提案が台帳から消えました").toContain(RETURNED.reason);
      const committedLedger = await gitWhileRunning(workFolder, ["show", "HEAD:.aiwriter/proposals/proposals.jsonl"]);
      expect(committedLedger, "書きかけの提案が記録（コミット）に入りました").not.toContain(DRAFT.reason);

      /* ── 3. 「2. 校閲する話を選ぶ」→ 範囲を押さえた知らせ ── */
      await clearNotifications(page);
      await clickMenuRow(page, RANGE_STEP);
      await waitForQuickPick(page, "校閲する範囲：始めの話を選びます");
      await pickQuickPickRow(page, EPISODE);
      await waitForQuickPick(page, "校閲する範囲：終わりの話を選びます");
      await pickQuickPickRow(page, EPISODE);
      await waitForQuickPick(page, "何をしているかを、作者へ伝えます");
      await pickQuickPickRow(page, "校閲中");
      let shown = "";
      // 済んだ知らせ（notifyDone）は下の帯に6秒だけ出るので、押した直後から見続ける
      await waitUntil(
        async () => {
          const found = [...(await statusBarTexts(page)), ...(await notificationTexts(page))].find((text) => text.includes("を校閲中にしました"));
          shown = found ?? "";
          return found !== undefined;
        },
        "「…を校閲中にしました。」が下の帯（または右下の知らせ）に出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      // 範囲の言い方は話数か、読めなければファイル名（`core/editingRepo.ts` の `describeLockRange`）
      expect(shown, `知らせ：${shown}`).toMatch(/(第1話|001_駅\.txt)を校閲中にしました。/);
      // 鍵は送り先へ届く（作者の側が書き続けないよう、すぐ知らせる道）。届かなかったときの
      // 「同期すると届きます」は、編集者モードでは「保存・同期」が送らないので出てはいけない
      const { remote } = places(root);
      await waitUntil(
        async () => (await git(root, [`--git-dir=${remote}`, "show", "main:.aiwriter/locks/locks.jsonl"]).catch(() => "")).includes("acquire"),
        "校閲の鍵が送り先へ届く",
        30_000
      ).catch(async (error: unknown) => {
        // 止まった段と git の文は製品のログにある（reviewProposals.ts の「校閲の範囲を知らせる」。0.134.2）
        const log = await readFile(path.join(workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "（ログが無い）");
        const tail = log.split(/\r?\n/).slice(-30).join("\n");
        throw new Error(
          `${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／${await describeNotices(session)}／状態：${await gitWhileRunning(workFolder, ["status", "--short"])}／設定の名乗り：${JSON.stringify(await gitWhileRunning(workFolder, ["config", "--get", "user.name"]).catch(() => "（無い）"))}）\n製品のログの末尾：\n${tail}`
        );
      });
      await holdsFor(
        async () => !(await notificationTexts(page)).some((text) => text.includes("同期すると")),
        "範囲を押さえたあと、作者モードの言い方（同期すると…）の知らせが出ない",
        3_000
      );
    },
    LAUNCH
  );
}, 300_000);
