/**
 * 「保存・同期」の入口と、止まった所から次に押す所（画面の自動テスト、設計書5.5.18・6.113。
 * 実機確認リスト 0.121.0 の 326 行の残り・328 行を機械へ移した。作者の判断 2026-11-01
 * 「同期の入口は保存・同期1つ」「止まった所から次の一手を押せるようにする」）。
 *
 * 1. 326 の残り：作品Aの本文を書き換えて下の帯に「未記録 N」が出たら、それを押すと作品の一覧ではなく
 *    「保存・同期」の確認の窓（「N か所を同期します」）が出る。［同期する］で記録して送り、
 *    送り先の無い作品B（git の置き場だが送り先が無い）があるので、済んだ知らせに［GitHub初期設定］が付く（328 の後半）
 * 2. 328 の前半：作品Aを「このPC」と「もう1台」の両方で同じ行を直した状態で「保存・同期」を押し、
 *    残す文を選ぶ画面を Esc で閉じると、止まった知らせに［どちらを残すか選ぶ］が出る。押すと、
 *    作品が2つあるのに作品を選ぶ画面（「どの作品の原稿をそろえますか」）を出さずに、作品Aの分岐合流が始まる
 *
 * **GitHub は呼ばない。** 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts` の
 * `addLocalRemote`）。「もう1台」はその置き場を clone したフォルダー（`gitSyncMenuWording` と同じ形）。
 * 自動の送り直し・自動の取りに行きは切る（押す前に勝手に送り・取り込みが走ると、見たい状態が崩れる）。
 * ［GitHub初期設定］は押さない（押すと GitHub へつなぎに行く）。
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
  notificationTexts,
  pressDialogButton,
  quickInputWaitContext,
  quickPickTitle,
  statusBarTexts,
  waitForQuickPick,
} from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const FIRST_LINE = "　一話の本文。";
const HERE_LINE = "　一話の本文（このPCで直した）。";
const THERE_LINE = "　一話の本文（もう1台で直した）。";

const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";

/**
 * 起こし方：作品A（画面テストの作品）を送り先つきの置き場に、作品B を送り先の無い置き場にする。
 * 「もう1台」（送り先の clone）も用意する。直すのは起こしたあと（`gitSyncMenuWording` と同じ理由：
 * 起こした時点で GitHub だけが進んでいると、開いたときの点検が先に取り込んでしまう）
 */
function launchOptions(): LaunchOptions {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  return {
    settings: { "novelai.git.autoResend": false, "novelai.git.autoFetch": false },
    keybindings: [registerOther],
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
      // 作品B：同じ書庫の中に、送り先の無い別の置き場
      const other = path.join(path.dirname(workFolder), OTHER_TITLE);
      await mkdir(path.join(other, "本文"), { recursive: true });
      await writeFile(path.join(other, "本文", "001_別の話.txt"), "　別の作品の本文。\n", "utf8");
      await initRepoWithFirstCommit(other);
      registerOther.args = { folderPath: other, title: OTHER_TITLE };
    },
  };
}

function remoteFolder(session: E2ESession): string {
  return path.join(path.dirname(path.dirname(session.workFolder)), "送り先.git");
}

/** 作品Bを登録し、作品A・作品Bそれぞれの登録の印を記録しておく（以後の「未記録」を本文の書き換えだけにする） */
async function registerOtherAndSettle(session: E2ESession): Promise<void> {
  const { page, workFolder } = session;
  const other = path.join(path.dirname(workFolder), OTHER_TITLE);
  await page.keyboard.press(REGISTER_OTHER_PRESS);
  await waitUntil(() => existsSync(path.join(other, ".aiwriter", "config.json")), "作品Bの登録の印（config.json）ができる", 30_000);
  await waitUntil(() => existsSync(path.join(workFolder, ".aiwriter", "config.json")), "作品Aの登録の印（config.json）ができる", 30_000);
  // 登録のすぐあとは製品が印を書き足すことがある（librarySyncRecord の registerOther と同じ間）
  await page.waitForTimeout(2_500);
  for (const folder of [workFolder, other]) {
    await gitWhileRunning(folder, ["add", "-A"]);
    await gitWhileRunning(folder, ["commit", "--quiet", "--allow-empty", "-m", "登録の印"]);
  }
  await gitWhileRunning(workFolder, ["push", "--quiet"]);
  await clearNotifications(page);
}

/** 知らせ（右下）のうち `text` を含むもののボタンの名前 */
async function toastButtons(page: Page, text: string): Promise<string[]> {
  const toast = page.locator(".notification-toast", { hasText: text }).first();
  if ((await toast.count()) === 0) return [];
  return toast.evaluate((node) => Array.from(node.querySelectorAll(".monaco-button")).map((button) => (button.textContent ?? "").trim()));
}

/* ── 1. 下の帯の「未記録 N」→ 保存・同期の確認の窓 → 済んだ知らせの［GitHub初期設定］ ── */

test("下の帯の「未記録 N」を押すと、作品の一覧ではなく「N か所を同期します」の確認の窓が出て、［同期する］で記録して送り、送り先の無い作品があるので済んだ知らせに［GitHub初期設定］が付く", async () => {
  await withVsCode(
    "下の帯の未記録から保存・同期",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page, workFolder } = session;
      await registerOtherAndSettle(session);

      await writeFile(path.join(session.manuscriptFolder, EPISODE), `${HERE_LINE}\n`, "utf8");
      const bar = page.locator(".part.statusbar .statusbar-item", { hasText: "未記録" }).first();
      await waitUntil(async () => (await bar.count()) > 0 && (await bar.isVisible()), "下の帯に「未記録 N」が出る", 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}）`);
      });
      await bar.locator("a, .statusbar-item-label").first().click();

      let confirm = "";
      await waitUntil(async () => /\d+か所を同期します/.test((confirm = (await dialogText(page)) ?? "")), "「N か所を同期します」の確認の窓が出る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの窓：${JSON.stringify(confirm)}）${await quickInputWaitContext(page)}`);
        }
      );
      expect(await quickPickTitle(page), "確認の窓の前に、作品を選ぶ一覧が出ています").toBeUndefined();
      const before = (await git(remoteFolder(session), ["rev-parse", "main"])).trim();
      await pressDialogButton(page, "同期する");

      // 記録して送った（本文の書き換えが記録待ちに残らず、送り先が進む）
      await waitUntil(async () => (await porcelainLines(workFolder)).length === 0, "作品Aの書き換えが記録される", 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（git status：${JSON.stringify(await porcelainLines(workFolder))}／${await describeNotices(session)}）`);
      });
      await waitUntil(async () => (await git(remoteFolder(session), ["rev-parse", "main"])).trim() !== before, "作品Aの記録が送り先へ届く", 30_000);

      // 済んだ知らせに［GitHub初期設定］（送り先の無い作品Bのため）
      let buttons: string[] = [];
      await waitUntil(
        async () => {
          for (const text of await notificationTexts(page)) {
            const found = await toastButtons(page, text.split("\n")[0]);
            if (found.includes("GitHub初期設定")) {
              buttons = found;
              return true;
            }
          }
          return false;
        },
        "済んだ知らせに［GitHub初期設定］が付く",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／窓：${JSON.stringify(await dialogText(page))}）`);
      });
      expect(buttons).toContain("GitHub初期設定");
    },
    launchOptions()
  );
}, 300_000);

/* ── 2. 両方で同じ行を直した作品：残す文を選ぶ画面を閉じる → ［どちらを残すか選ぶ］→ 作品を訊かずに分岐合流 ── */

test("両方で同じ行を直した作品で「保存・同期」を押し、残す文を選ぶ画面を閉じると、知らせに［どちらを残すか選ぶ］が出て、押すと作品を選ばずにその作品の分岐合流が始まる", async () => {
  await withVsCode(
    "保存・同期の途中で閉じたあとの分岐合流",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page, workFolder } = session;
      await registerOtherAndSettle(session);

      // 両方で同じ行を直す：もう1台で直して送り、このPCでも直して記録する（送らない）
      const there = path.join(path.dirname(path.dirname(workFolder)), "もう1台");
      await git(there, ["pull", "--quiet"]);
      await writeFile(path.join(there, "本文", EPISODE), `${THERE_LINE}\n`, "utf8");
      await git(there, ["commit", "--quiet", "-am", "もう1台で直した"]);
      await git(there, ["push", "--quiet"]);
      await writeFile(path.join(session.manuscriptFolder, EPISODE), `${HERE_LINE}\n`, "utf8");
      await gitWhileRunning(workFolder, ["commit", "--quiet", "-am", "このPCで直した"]);
      await gitWhileRunning(workFolder, ["fetch", "--quiet"]);
      const counts = (await gitWhileRunning(workFolder, ["rev-list", "--left-right", "--count", "HEAD...origin/main"])).trim().split(/\s+/).join(" ");
      if (counts !== "1 1") throw new Error(`両方で1件ずつ直した状態になりません（このPC…GitHub の差：${counts}／git status：${JSON.stringify(await porcelainLines(workFolder))}）`);
      await clearNotifications(page);

      await runCommand(page, "保存・同期");
      let confirm = "";
      await waitUntil(async () => /\d+か所を同期します/.test((confirm = (await dialogText(page)) ?? "")), "「保存・同期」の確認の窓が出る", 60_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの窓：${JSON.stringify(confirm)}）${await quickInputWaitContext(page)}`);
      });
      await pressDialogButton(page, "同期する");

      // 残す文を選ぶ画面を、途中で閉じる
      await waitForQuickPick(page, `${EPISODE}：どちらの文を残しますか`, 60_000);
      await page.keyboard.press("Escape");
      // 閉じると「選ばずに閉じました。原稿はまだ何も変えていません。」と訊かれる。作者が途中でやめる道を選ぶ
      let asked = "";
      await waitUntil(async () => (asked = (await dialogText(page)) ?? "").includes("選ばずに閉じました"), "閉じたあとに「選ばずに閉じました」の窓が出る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの窓：${JSON.stringify(asked)}）${await quickInputWaitContext(page)}`);
        }
      );
      expect(asked, `窓の文：${asked}`).toContain("原稿はまだ何も変えていません");
      await pressDialogButton(page, "そろえるのをやめる");

      // 止まった知らせ（確認の窓）に［どちらを残すか選ぶ］
      let stopped = "";
      await waitUntil(
        async () => {
          stopped = (await dialogText(page)) ?? "";
          return (await page.locator(".monaco-dialog-box .monaco-button", { hasText: "どちらを残すか選ぶ" }).count()) > 0;
        },
        "止まった知らせに［どちらを残すか選ぶ］が出る",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの窓：${JSON.stringify(stopped)}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
      });
      // 閉じたので原稿は合わせる前のまま（このPCの文）
      expect((await gitWhileRunning(workFolder, ["show", `HEAD:本文/${EPISODE}`])).replace(/\r\n/g, "\n")).toBe(`${HERE_LINE}\n`);

      await page.locator(".monaco-dialog-box .monaco-button", { hasText: "どちらを残すか選ぶ" }).first().click();
      /*
        作品は2つ（A・B）あるが、押した所の作品（A）で始まるので、作品を選ぶ画面「どの作品の原稿をそろえますか」は
        出ず、分岐合流の入口の確認の窓（「「画面テストの作品」：2台の原稿をそろえます。」）が出る
      */
      let entry = "";
      await waitUntil(
        async () => {
          if ((await quickPickTitle(page)) === "どの作品の原稿をそろえますか") return true;
          entry = (await dialogText(page)) ?? "";
          return entry.includes("2台の原稿をそろえます");
        },
        "［どちらを残すか選ぶ］で分岐合流が始まる",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの窓：${JSON.stringify(entry)}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
      });
      expect(await quickPickTitle(page), "［どちらを残すか選ぶ］を押したのに、作品を選ぶ画面が出ました").toBeUndefined();
      expect(entry, `分岐合流の入口の窓：${entry}`).toContain(`「${E2E_WORK_TITLE}」：2台の原稿をそろえます。`);
      await page.keyboard.press("Escape");
      await holdsFor(async () => (await gitWhileRunning(workFolder, ["show", `HEAD:本文/${EPISODE}`])).replace(/\r\n/g, "\n") === `${HERE_LINE}\n`, "閉じたら原稿は変わらない", 2_000);
    },
    launchOptions()
  );
}, 300_000);
