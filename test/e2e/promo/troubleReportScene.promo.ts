/**
 * Discord「機能紹介」用の広報素材：障害報告用の記録（作者の依頼 2026-10-22）。
 * features.md の文：直近の記録をテキスト1枚に書き出せる。原稿の本文・AIの応答・人物名・作品名・APIキーは伏せる。外へは送らない。
 * 「ヘルプ → 障害報告用の記録」から使える。
 *
 * 書き出す前の確認（何を入れて何を伏せるか）と、書き出したあとの案内を見せる。**書き出した記録の中身は映さない**
 * （作り物の作品でも、保管庫の記録に実在のパスが混ざる恐れがあるため）。AIは呼ばない。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/troubleReportScene.promo.ts`
 */
import { test } from "vitest";
import { openEpisode } from "../support/manuscriptFrame";
import { runCommand } from "../support/quickInput";
import { waitUntil } from "../support/wait";
import { notificationTexts, pickQuickPickRow, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";
import { hideCaption } from "./support/overlay";

const EPISODE = "001_雨の駅.txt";
const TEXT = "　終電を逃した駅のホームに、雨の音だけが残っていた。\n　ホームの時計が、零時を指していた。\n";

test("障害報告用の記録の広報素材を撮る", async () => {
  await recordFeature({
    name: "trouble-report",
    subtitle: "障害報告用の記録 — 本文・人物名・鍵を伏せて書き出す",
    workTitle: "雨の駅",
    episodes: [{ name: EPISODE, text: TEXT }],
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    snapAt: 10,
    open: async ({ page }) => {
      await openEpisode(page, EPISODE, "零時を指していた");
    },
    play: async ({ page }, caption) => {
      await caption("「障害報告用の記録を書き出す」を選ぶ");
      await page.waitForTimeout(800);
      await runCommand(page, "障害報告用の記録を書き出す");
      const seen: string[] = [];
      await waitUntil(
        async () => {
          const title = (await quickPickTitle(page)) ?? "";
          if (title !== "" && !seen.includes(title)) seen.push(title);
          if (title.includes("どの作品の記録")) {
            await pickQuickPickRow(page, "雨の駅");
            return false;
          }
          return title.includes("どこまでさかのぼるか");
        },
        "さかのぼる範囲の選択が出る",
        30_000
      );
      await page.waitForTimeout(1_500);
      await caption("さかのぼる範囲を選ぶ");
      await page.keyboard.press("Enter");
      await waitUntil(async () => (await quickPickRows(page)).some((row) => row.label === "書き出す"), "書き出す前の確認が出る", 30_000);
      await caption("書き出す前に、何を入れて何を伏せるかを見せる");
      await page.waitForTimeout(1_500);
      // 一覧の下の「伏せるもの」まで巻いて見せる
      await page.mouse.move(640, 250);
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(350);
      }
      await page.waitForTimeout(1_700);
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(600);
      const rows = await quickPickRows(page);
      process.stdout.write(`[広報] 確認の行：${JSON.stringify(rows.map((row) => row.label))}\n`);
      await pickQuickPickRow(page, "書き出す");      await waitUntil(
        async () => (await notificationTexts(page)).some((text) => text.includes("書き出しました")),
        "書き出したあとの案内が出る",
        30_000
      );
      await hideCaption(page);
      await page.waitForTimeout(2_500);
    },
  });
});
