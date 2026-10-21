/**
 * Discord「機能紹介」用の広報素材：目標に届いたときのお祝い（作者の依頼 2026-10-22）。
 * features.md の文：目標に届くと、執筆統計に風船が上がる。1日・1か月の目標字数は設定で決める。
 *
 * 祝いは**保存のとき**に判定される（記録を置くだけでは上がらない。1回目の撮りで確かめた）ので、
 * 低い目標を決め、統計を開いたまま本文を書き足して保存する。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/goalCelebrationScene.promo.ts`
 */
import { test } from "vitest";
import { runCommand } from "../support/quickInput";
import { statsFrame } from "../support/statsFixture";
import { waitUntil } from "../support/wait";
import { activateTab, quickOpen } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

const ADD = "　傘を持たない彼女は、時計の針ばかりを見つめている。雨は止む気配もなく、最終のアナウンスだけが遠くで響いていた。".repeat(2);

test("目標のお祝いの広報素材を撮る", async () => {
  await recordFeature({
    name: "goal-celebration",
    subtitle: "目標に届いたら、風船でお祝い",
    workTitle: "雨の駅",
    episodes: [{ name: "001_雨の駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n" }],
    settings: { "novelai.stats.dailyGoal": 100, "window.zoomLevel": 0 },
    keybindings: [{ key: "ctrl+alt+shift+f8", command: "workbench.action.reopenTextEditor" }],
    snapAt: 12,
    play: async ({ page }, caption) => {
      await caption("1日の目標字数を決めておくと");
      await page.waitForTimeout(1_500);
      await runCommand(page, "執筆統計");
      await waitUntil(async () => (await statsFrame(page)) !== undefined, "執筆統計の画面が開く", 30_000);
      await page.waitForTimeout(1_500);
      await quickOpen(page, "001_雨の駅.txt");
      await page.keyboard.press("Control+Alt+Shift+F8");
      await page.waitForTimeout(1_500);
      await page.keyboard.press("Control+End");
      // 1回目の保存は基準を置くだけ（増減を数えない）ので、先に1字だけ足して保存しておく
      await page.keyboard.insertText("。");
      await page.keyboard.press("Control+KeyS");
      await page.waitForTimeout(2_000);
      await caption("書き進めて保存し、目標に届くと");
      await page.keyboard.insertText(ADD);
      await page.waitForTimeout(800);
      await page.keyboard.press("Control+KeyS");
      await page.waitForTimeout(2_000);
      // 統計は別のタブなので、戻ると見えるようになったところで祝いが上がる
      await activateTab(page, "執筆統計: 雨の駅");
      await caption("執筆統計に風船が上がる");
      await page.waitForTimeout(6_500);
    },
  });
});
