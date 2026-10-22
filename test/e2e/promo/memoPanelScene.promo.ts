/**
 * Discord「機能紹介」用の広報素材：メモと校正・メモパネル（作者の依頼 2026-10-22）。
 * features.md の文：行頭に「//」で書くと付箋になり、校正・メモパネルにメモが位置順に並ぶ。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/memoPanelScene.promo.ts`
 */
import type { Frame } from "playwright-core";
import { test } from "vitest";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { waitUntil } from "../support/wait";
import { recordFeature } from "./support/featureScene";

const EPISODE = "001_雨の駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "// TODO 雨の描写をもう一度入れて、場面を締める",
  "　ミナは傘を持っていない。改札の向こうで、見知らぬ男が手を振っている。",
  "// 伏線 男の声に聞き覚えがある、と後で回収する",
  "　「待ってたよ」と彼は言った。",
  "// 要確認 時刻は零時で合っているか",
  "　ホームの時計が、零時を指していた。",
  "",
].join("\n");

test("メモパネルの広報素材を撮る", async () => {
  let frame!: Frame;
  let panel!: Frame;
  await recordFeature({
    name: "memo-panel",
    subtitle: "メモと校正 — 付箋を位置順に",
    workTitle: "雨の駅",
    episodes: [{ name: EPISODE, text: TEXT }],
    snapAt: 8,
    open: async ({ page }) => {
      frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");
      await page.keyboard.press("Control+Alt+KeyM");
      await waitUntil(
        async () => {
          const found = await memoPanelFrame(page);
          if (found && (await found.locator("button.go").count()) >= 3) {
            panel = found;
            return true;
          }
          return false;
        },
        "校正・メモパネルにメモ3件が並ぶ",
        30_000
      );
      await placeCaretAfter(frame, "終電を逃した");
      await page.mouse.move(320, 640);
    },
    play: async ({ page }, caption) => {
      await caption("行頭に「//」で書くと、付箋になる");
      await page.waitForTimeout(3_500);
      await caption("校正・メモパネルに、メモが位置順に並ぶ");
      await page.waitForTimeout(3_000);
      await panel.locator("button.go").nth(1).click();
      await caption("押すと、その行へ飛べる");
      await page.waitForTimeout(4_000);
    },
  });
});
