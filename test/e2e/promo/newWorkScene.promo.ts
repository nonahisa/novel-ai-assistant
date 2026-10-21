/**
 * Discord「機能紹介」用の広報素材：新規執筆開始（作者の依頼 2026-10-22）。
 * features.md の文：プロット起点か本文起点かを選んで始められる。あとからどちらへも移れる。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/newWorkScene.promo.ts`
 */
import { test } from "vitest";
import { answerInput } from "../support/quickInput";
import { runCommand } from "../support/quickInput";
import { waitUntil } from "../support/wait";
import { quickPickTitle } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

test("新規執筆開始の広報素材を撮る", async () => {
  await recordFeature({
    name: "new-work",
    subtitle: "新規執筆開始 — プロットからでも本文からでも",
    workTitle: "雨の駅",
    episodes: [{ name: "001_雨の駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n" }],
    snapAt: 13,
    play: async ({ page }, caption) => {
      await caption("新しい作品を、プロットからでも本文からでも始められる");
      await page.waitForTimeout(2_500);
      await runCommand(page, "プロット起点");
      await waitUntil(async () => (await quickPickTitle(page)) !== undefined, "作品名の入力が出る", 20_000);
      await caption("まず作品名を入れる");
      await page.waitForTimeout(1_500);
      await answerInput(page, "星降る港町");
      // 種類・タイプの問いは、先頭の選択肢（小説など）をそのまま受ける
      for (let step = 0; step < 3; step++) {
        await page.waitForTimeout(1_800);
        const title = (await quickPickTitle(page)) ?? "";
        process.stdout.write(`[広報] 問い: ${title}\n`);
        if (step === 0) await caption("種類やタイプを選ぶと、作品フォルダーができる");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(500);
        if ((await quickPickTitle(page)) === undefined) break;
      }
      await caption("プロットの見出しがついた状態で開く");
      await page.waitForTimeout(4_000);
    },
  });
});
