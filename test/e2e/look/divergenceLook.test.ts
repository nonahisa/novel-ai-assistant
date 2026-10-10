/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、［分岐合流］を押したときの確認の窓と選ぶ画面の写真
 * （2026-10-09 の二段目。作者が見た目の良し悪しを判断するための写真。判断そのものはしない）。
 *
 * **GitHub は呼ばない。** 送り先は同じ一時フォルダーの中の素の置き場（`remote.git`）で、
 * 別の機械の代わりにもう1つ写し（`clone2`）を作り、同じ話の同じ行を両側で書き換えて分岐させる。
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "vitest";
import { git, initRepoWithFirstCommit } from "../support/gitFixture";
import { runCommand } from "../support/quickInput";
import { SIDEBAR_LAUNCH } from "../support/sidebar";
import { withVsCode } from "../support/vscodeApp";
import { clearNotifications, dialogText, pressDialogButton, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { lookEnabled, lookNote, shootPage, shootPageKeepingToasts } from "./lookSupport";

const EPISODE = "第1話_はじまり.txt";

describe.skipIf(!lookEnabled)("見た目の写真：分岐合流", () => {
  test("同じ行を両側で書き換えて分岐させ、［分岐合流］を押す", async () => {
    await withVsCode(
      "見た目の写真：分岐合流",
      [{ name: EPISODE, text: "朝の駅は静かだった。\n改札を抜けて、白い息を吐いた。\nホームの時計が、零時を指していた。\n" }],
      async (session) => {
        const { page } = session;
        await clearNotifications(page);
        await runCommand(page, "分岐合流");
        // 確認の窓・選ぶ画面を順に撮る（押すのは先頭の選択肢。取りやめたいときはそのまま閉じる）
        for (let step = 0; step < 14; step++) {
          await page.waitForTimeout(2000);
          const dialog = await dialogText(page);
          if (dialog) {
            await lookNote(`[758-手順${step}] 確認の窓：${dialog.replace(/\s+/g, " ").slice(0, 700)}`);
            await shootPage(page, `758-手順${step}-確認の窓`);
            const buttons = await page.locator(".monaco-dialog-box .monaco-button").allInnerTexts();
            await lookNote(`[758-手順${step}] ボタン：${buttons.join(" / ")}`);
            // 「そろえる」「続ける」などの進むボタンを押す（無ければ先頭。0.102.7 で「合わせる」から改めた）
            const go = buttons.find((text) => /そろえる|合わせる|続ける|進む|はい|OK/.test(text)) ?? buttons[0];
            if (go) await pressDialogButton(page, go).catch(() => undefined);
            continue;
          }
          const title = await quickPickTitle(page);
          if (title !== undefined) {
            const rows = await quickPickRows(page);
            await lookNote(`[758-手順${step}] 選ぶ画面：${title}｜${rows.map((row) => `${row.label}〔${row.description}〕`).join(" / ").slice(0, 600)}`);
            await shootPage(page, `758-手順${step}-選ぶ画面`);
            await page.keyboard.press("Escape");
            break;
          }
          const toasts = await page.locator(".notification-toast").allInnerTexts();
          if (toasts.length > 0) {
            await lookNote(`[758-手順${step}] 知らせ：${toasts.map((text) => text.replace(/\s+/g, " ")).join(" ／ ").slice(0, 500)}`);
            await shootPageKeepingToasts(page, `758-手順${step}-知らせ`);
          }
        }
      },
      {
        ...SIDEBAR_LAUNCH,
        windowSize: { width: 1280, height: 800 },
        prepareWork: async ({ workFolder, manuscriptFolder }) => {
          const root = path.resolve(workFolder, "..", "..");
          const remote = path.join(root, "remote.git");
          const clone = path.join(root, "clone2");
          await initRepoWithFirstCommit(workFolder);
          await git(root, ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
          await git(workFolder, ["remote", "add", "origin", remote]);
          await git(workFolder, ["push", "--quiet", "-u", "origin", "main"]);
          // 別の機械の代わり：同じ話の1行目を書き換えて送る
          await git(root, ["clone", "--quiet", remote, clone]);
          await git(clone, ["config", "user.name", "別の機械"]);
          await git(clone, ["config", "user.email", "other@example.invalid"]);
          await git(clone, ["config", "core.autocrlf", "false"]);
          await writeFile(path.join(clone, "本文", EPISODE), "夜の駅は静かだった。\n改札を抜けて、白い息を吐いた。\nホームの時計が、零時を指していた。\n", "utf8");
          await git(clone, ["commit", "--quiet", "-am", "別の機械で書き換え"]);
          await git(clone, ["push", "--quiet", "origin", "main"]);
          // こちら：同じ1行目を別の字へ書き換えて記録する（送らない）
          await writeFile(path.join(manuscriptFolder, EPISODE), "昼の駅は静かだった。\n改札を抜けて、白い息を吐いた。\nホームの時計が、零時を指していた。\n", "utf8");
          await git(workFolder, ["commit", "--quiet", "-am", "こちらで書き換え"]);
          // 取り込む前でも分岐が見えるよう、いちど取りに行っておく
          await git(workFolder, ["fetch", "--quiet", "origin"]);
        },
      }
    );
  });
});
