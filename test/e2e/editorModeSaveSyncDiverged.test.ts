/**
 * 編集者モードで、作者の側と原稿が分かれた状態の「保存・同期」（画面の自動テスト、設計書5.5.18・5.6・6.113。
 * 実機確認リスト 0.122.0 の「編集者モード（kmizu さんの環境）で、作者の側と原稿が分かれた状態にして「保存・同期」を
 * 押すと、知らせのボタンが［校閲を終えて返す］で、［どちらを残すか選ぶ］は出ない…」のうち、e2e/editorModeReturnBlocked
 * が見ていない残り（知らせのボタン）を機械へ移した。作者の判断 2026-11-02「編集者は分岐合流を使わない」）。
 *
 * 見張ること：
 * - 編集者モードの作品（編集用リポジトリの写し）で、手元に送っていない提案の記録が1件あり、作者の側も原稿を直して
 *   送ってある（分かれている）とき、「保存・同期」を押すと、知らせのボタンが［校閲を終えて返す］で、
 *   ［どちらを残すか選ぶ］は出ない。合わせる画面（残す文を選ぶ・分岐合流の確認）にも進まない
 * - 手元の記録は動かない（受け取るだけの環境なので、合わせにいかない）
 *
 * **GitHub は呼ばない。** 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts`）、「作者の側」は
 * その置き場を clone したフォルダー（`saveAndSyncNextSteps` の「もう1台」と同じ形）。分かれた状態は**起こしたあと**に
 * 作る（起こした時点で分かれていると、開いたときの点検が先に拾って別の知らせを出す）。自動の送り直し・
 * 自動の取りに行きは切る。［校閲を終えて返す］は押さない（押すと送り先へ送る道で、ここで見るのはボタンまで）。
 * **AI は呼ばない。**
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { HAND_EDIT_CATEGORY, proposalId } from "../../src/models/proposal";
import { describeNotices } from "./support/noticeRecord";
import { addLocalRemote, git, gitWhileRunning, initRepoWithFirstCommit } from "./support/gitFixture";
import { runCommand } from "./support/quickInput";
import { withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, dialogText, notificationTexts, quickInputWaitContext, quickPickTitle } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const LINE = "　終電を逃した駅のホームに、雨の音だけが残っていた。";
const AUTHOR_LINE = "　終電を逃した駅のホームに、雨の音だけが響いていた。";
const FILE = `本文/${EPISODE}`;

const LAUNCH: LaunchOptions = {
  settings: { "novelai.mode": "editor", "novelai.git.autoResend": false, "novelai.git.autoFetch": false },
  prepareWork: async ({ workFolder }) => {
    const root = path.dirname(path.dirname(workFolder));
    await initRepoWithFirstCommit(workFolder);
    await addLocalRemote(workFolder, path.join(root, "送り先.git"));
    const author = path.join(root, "作者の機械");
    await git(root, ["clone", "--quiet", path.join(root, "送り先.git"), author]);
    await git(author, ["config", "user.name", "作者"]);
    await git(author, ["config", "user.email", "e2e-author@example.invalid"]);
    await git(author, ["config", "core.autocrlf", "false"]);
  },
};

/** 右下の知らせのうち `text` を含むもののボタンの名前 */
async function toastButtons(page: Page, text: string): Promise<string[]> {
  const toast = page.locator(".notification-toast", { hasText: text }).first();
  if ((await toast.count()) === 0) return [];
  return toast.evaluate((node) => Array.from(node.querySelectorAll(".monaco-button")).map((button) => (button.textContent ?? "").trim()));
}

test("編集者モードで作者の側と分かれた作品の「保存・同期」を押すと、知らせのボタンが［校閲を終えて返す］で［どちらを残すか選ぶ］は出ず、合わせる画面へ進まない", async () => {
  await withVsCode(
    "編集者モードの保存・同期（分かれたとき）",
    [{ name: EPISODE, text: `${LINE}\n` }],
    async (session) => {
      const { page, workFolder, root } = session;
      await waitUntil(() => existsSync(path.join(workFolder, ".aiwriter", "config.json")), "作品の登録の印（config.json）ができる", 30_000);
      // 登録のすぐあとは製品が印を書き足すことがある（saveAndSyncNextSteps と同じ間）
      await page.waitForTimeout(2_500);

      // 編集者の側：提案を1件置いて記録する（送らない）。登録の印も同じ記録に入れる
      const ledger = path.join(workFolder, ".aiwriter", "proposals", "proposals.jsonl");
      await mkdir(path.dirname(ledger), { recursive: true });
      const proposal = {
        kind: "proposal",
        id: proposalId(FILE, 1, "雨の音", `雨音\u0000音の重なりを避けたい`),
        time: "2026-11-02T09:00:00.000Z",
        proposer: "画面テスト編集者",
        file: FILE,
        line: 1,
        original: LINE,
        target: "雨の音",
        suggestion: "雨音",
        reason: "音の重なりを避けたい",
        category: HAND_EDIT_CATEGORY,
      };
      await appendFile(ledger, `${JSON.stringify(proposal)}\n`, "utf8");
      await gitWhileRunning(workFolder, ["add", "-A"]);
      await gitWhileRunning(workFolder, ["commit", "--quiet", "-m", "提案を置いた"]);

      // 作者の側：原稿を直して送る
      const author = path.join(root, "作者の機械");
      await writeFile(path.join(author, "本文", EPISODE), `${AUTHOR_LINE}\n`, "utf8");
      await git(author, ["commit", "--quiet", "-am", "作者が直した"]);
      await git(author, ["push", "--quiet"]);

      await gitWhileRunning(workFolder, ["fetch", "--quiet"]);
      const counts = (await gitWhileRunning(workFolder, ["rev-list", "--left-right", "--count", "HEAD...origin/main"])).trim().split(/\s+/).join(" ");
      if (counts !== "1 1") throw new Error(`編集者の側と作者の側が1件ずつ分かれた状態になりません（手元…送り先の差：${counts}）`);
      const headBefore = (await gitWhileRunning(workFolder, ["rev-parse", "HEAD"])).trim();
      await clearNotifications(page);

      await runCommand(page, "保存・同期");
      let found = "";
      let buttons: string[] = [];
      await waitUntil(
        async () => {
          for (const text of await notificationTexts(page)) {
            if (!text.includes("分かれて") && !text.includes("同期")) continue;
            found = text;
            buttons = await toastButtons(page, text.split("\n")[0]);
            return true;
          }
          return false;
        },
        "「保存・同期」の済んだ知らせが出る",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／ボタン：${JSON.stringify(buttons)}／窓：${JSON.stringify(await dialogText(page))}／${await describeNotices(session)}）${await quickInputWaitContext(page)}`
        );
      });
      // 同じ知らせの中のボタンは文と一緒に描かれるが、念のため描き終わりを待ってから読み直す
      await page.waitForTimeout(500);
      buttons = await toastButtons(page, found.split("\n")[0]);
      expect(buttons, `知らせ：${found}`).toContain("校閲を終えて返す");
      expect(buttons, `知らせ：${found}`).not.toContain("どちらを残すか選ぶ");

      // 合わせる画面へ進まない（残す文を選ぶ画面・分岐合流の確認の窓）。手元の記録も動かない
      await holdsFor(
        async () => (await quickPickTitle(page)) === undefined && !((await dialogText(page)) ?? "").includes("合わせ"),
        "合わせる画面へ進まない",
        3_000
      );
      expect((await gitWhileRunning(workFolder, ["rev-parse", "HEAD"])).trim(), "受け取るだけの環境で、手元の記録が動きました").toBe(headBefore);
    },
    LAUNCH
  );
}, 240_000);
