/**
 * Discord「機能紹介」用の広報素材：スケジュール（作者の依頼 2026-10-22）。
 * features.md の文：締切・発売日・連載開始から、執筆・推敲・入稿などの段取りを逆算し、縦が時間・
 * 横が作品の1枚に並べる。1つの作品にいくつでも置ける。「執筆データ → スケジュール」から使える。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/scheduleScene.promo.ts`
 */
import { test } from "vitest";
import type { Frame } from "playwright-core";
import { runCommand } from "../support/quickInput";
import { dayKey, schedule, scheduleFrame, selfPublishSteps, writeScheduleFile } from "../support/scheduleFixture";
import { waitUntil } from "../support/wait";
import { recordFeature } from "./support/featureScene";

test("スケジュールの広報素材を撮る", async () => {
  let frame: Frame | undefined;
  await recordFeature({
    name: "schedule",
    subtitle: "スケジュール — 発売日から段取りを逆算",
    workTitle: "雨の駅",
    episodes: [{ name: "001_雨の駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n" }],
    settings: { "window.zoomLevel": 0 },
    prepareWork: async ({ workFolder }) => {
      const second = selfPublishSteps().map((item) => ({ ...item, id: `b-${item.id}`, parallelWith: item.parallelWith ? `b-${item.parallelWith}` : null }));
      await writeScheduleFile(workFolder, [
        schedule({ id: "sch-1", kind: "selfPublish", name: "Kindle版", milestone: dayKey(110), targetChars: 80_000, steps: selfPublishSteps() }),
        schedule({ id: "sch-2", kind: "selfPublish", name: "文庫版", milestone: dayKey(140), targetChars: 90_000, steps: second }),
      ]);
    },
    snapAt: 7,
    open: async ({ page }) => {
      await runCommand(page, "スケジュール");
      await waitUntil(async () => (frame = await scheduleFrame(page)) !== undefined, "スケジュール画面が開く", 30_000);
      await waitUntil(async () => ((await frame?.locator(".lane .bar").count()) ?? 0) > 0, "段の帯が描かれる", 20_000);
    },
    play: async ({ page }, caption) => {
      // 段の帯が画面の外にあるので、最初の帯が見える位置まで送る
      await frame?.locator(".lane .bar").first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      await caption("発売日や締切を決めると、段取りが逆算される");
      await page.waitForTimeout(5_000);
      await caption("縦が時間、横が作品。1つの作品にいくつでも置ける");
      await page.mouse.move(300, 400);
      for (let step = 0; step < 6; step++) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(2_000);
      await caption("執筆・推敲・入稿の段を、1枚に並べて見られる");
      await page.waitForTimeout(4_000);
    },
  });
});
