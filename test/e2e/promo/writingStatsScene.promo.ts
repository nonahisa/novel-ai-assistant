/**
 * Discord「機能紹介」用の広報素材：執筆統計（作者の依頼 2026-10-22）。
 * features.md の文：保存のたびの増減をその日の執筆量として記録。日次・週次・月次・年次のグラフ、
 * 目標線・達成率・連続日数。「執筆データ → 執筆統計」でパネルが開く。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/writingStatsScene.promo.ts`
 */
import { test } from "vitest";
import type { Frame } from "playwright-core";
import { runCommand } from "../support/quickInput";
import { statsFrame, writeStatsFile, type SampleDay } from "../support/statsFixture";
import { waitUntil } from "../support/wait";
import { recordFeature } from "./support/featureScene";

/** 30日ぶんの見本（今日はまだ目標の途中）。広報用の作り物 */
function sampleDays(): SampleDay[] {
  const nets = [1200, 1800, 900, 0, 2100, 1500, 1700, 600, 1900, 1400];
  return Array.from({ length: 30 }, (_, index) => ({
    offset: index - 29,
    net: index === 29 ? 800 : nets[index % nets.length] + (index % 3) * 100,
  }));
}

test("執筆統計の広報素材を撮る", async () => {
  let frame: Frame | undefined;
  await recordFeature({
    name: "writing-stats",
    subtitle: "執筆統計 — 書いた量が日ごとに残る",
    workTitle: "雨の駅",
    episodes: [{ name: "001_雨の駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n" }],
    settings: { "novelai.stats.dailyGoal": 1500, "window.zoomLevel": 0 },
    prepareWork: async ({ workFolder }) => writeStatsFile(workFolder, sampleDays()),
    snapAt: 8,
    open: async ({ page }) => {
      await runCommand(page, "執筆統計");
      await waitUntil(async () => (frame = await statsFrame(page)) !== undefined, "執筆統計の画面が開く", 30_000);
      await waitUntil(async () => ((await frame?.locator("#chart rect.bar").count()) ?? 0) >= 30, "日ごとの棒が描かれる", 20_000);
    },
    play: async ({ page }, caption) => {
      await caption("保存のたびに、書いた量が日ごとに記録される");
      await page.waitForTimeout(4_500);
      await caption("目標の線と、達成率・連続日数も見られる");
      await page.waitForTimeout(4_500);
      await caption("日次・週次・月次・年次のグラフに切り替えられる");
      await page.waitForTimeout(1_000);
      const week = frame?.getByText("週次", { exact: false }).first();
      if (week && (await week.count()) > 0) await week.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(3_500);
    },
  });
});
