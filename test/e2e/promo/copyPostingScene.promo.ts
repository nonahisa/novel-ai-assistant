/**
 * Discord「機能紹介」用の広報素材：コピー（投稿サイト用）（作者の依頼 2026-10-22）。
 * features.md の文：ルビ・傍点を投稿サイトの記法に変換してクリップボードへ入れる。原稿は書き換えない。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/copyPostingScene.promo.ts`
 */
import { test } from "vitest";
import { runCommand } from "../support/quickInput";
import { waitUntil } from "../support/wait";
import { clearNotifications, pickQuickPickRow, quickOpen, quickPickTitle } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

const EPISODE = "001_雨の駅.md";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　{切符|きっぷ}を握ったまま、ミナは{{坂の上}}を見上げる。",
  "",
].join("\n");

test("コピー（投稿サイト用）の広報素材を撮る", async () => {
  await recordFeature({
    name: "copy-posting",
    subtitle: "コピー（投稿サイト用）— 記法を変えて写す",
    workTitle: "雨の駅",
    episodes: [{ name: EPISODE, text: TEXT }],
    keybindings: [{ key: "ctrl+alt+shift+f8", command: "workbench.action.reopenTextEditor" }],
    snapAt: 14,
    open: async ({ page }) => {
      await quickOpen(page, EPISODE);
      await page.keyboard.press("Control+Alt+Shift+F8");
      await page.waitForTimeout(1_500);
    },
    play: async ({ page }, caption) => {
      await caption("原稿のルビや傍点を、投稿サイトの書き方に変えて写せる");
      await page.waitForTimeout(2_500);
      await runCommand(page, "コピー（投稿サイト用）");
      await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("どこへ貼りますか"), "貼り付け先の画面が出る", 20_000);
      await page.waitForTimeout(2_500);
      await pickQuickPickRow(page, "小説家になろう");
      await page.waitForTimeout(2_000);
      await caption("クリップボードへ入るだけ。原稿はそのまま");
      await page.waitForTimeout(2_500);
      await clearNotifications(page);
      // 貼ってみせる（新しい空のファイルへ）
      await page.keyboard.press("Control+KeyN");
      await page.waitForTimeout(800);
      await page.keyboard.press("Control+KeyV");
      await caption("貼ると、ルビは｜切符《きっぷ》の形になっている");
      await page.waitForTimeout(3_500);
    },
  });
});
