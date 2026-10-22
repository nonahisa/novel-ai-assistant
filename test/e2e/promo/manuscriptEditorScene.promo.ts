/**
 * Discord「機能紹介」用の広報素材：原稿エディター（縦書き・横書き）（作者の依頼 2026-10-22）。
 * features.md の文：縦書きでも横書きでも書ける。ルビは振り仮名、傍点は圏点として組んだまま打てる。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/manuscriptEditorScene.promo.ts`
 */
import type { Frame } from "playwright-core";
import { test } from "vitest";
import { composeText, openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { waitUntil } from "../support/wait";
import { recordFeature } from "./support/featureScene";

const EPISODE = "001_雨の駅.md";
const TEXT = [
  "　終電を逃した{駅|えき}のホームに、{雨|あめ}の音だけが残っていた。",
  "　ミナは{切符|きっぷ}を握ったまま、坂の上を見上げる。",
  "　改札の向こうに、{{白い傘}}が揺れている。",
  "",
].join("\n");

test("原稿エディターの広報素材を撮る", async () => {
  let frame!: Frame;
  await recordFeature({
    name: "manuscript-editor",
    subtitle: "原稿エディター — 縦書きも横書きも",
    workTitle: "雨の駅",
    episodes: [{ name: EPISODE, text: TEXT }],
    snapAt: 8,
    open: async ({ page }) => {
      frame = await openEpisode(page, EPISODE, "揺れている");
    },
    play: async ({ page }, caption) => {
      await page.mouse.move(640, 690);
      await caption("横書きでも、縦書きでも原稿が書ける");
      await page.waitForTimeout(3_000);
      await frame.locator("#dir").click();
      await waitUntil(
        async () => frame.evaluate(() => getComputedStyle(document.getElementById("compose") as HTMLElement).writingMode.startsWith("vertical")),
        "縦書きになる",
        10_000
      );
      await caption("ボタン1つで縦書きに。ルビも傍点も組んだまま");
      await page.waitForTimeout(3_500);
      await placeCaretAfter(frame, "揺れている。");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await caption("そのまま打ち込める");
      for (const ch of "　雨は、まだ止まない。") {
        await page.keyboard.insertText(ch);
        await page.waitForTimeout(180);
      }
      await waitUntil(async () => (await composeText(frame)).includes("まだ止まない"), "打った字が出る", 10_000);
      await page.waitForTimeout(2_500);
    },
  });
});
