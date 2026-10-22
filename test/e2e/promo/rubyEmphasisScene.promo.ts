/**
 * Discord「機能紹介」用の広報素材：ルビと傍点（作者の依頼 2026-10-22）。
 * features.md の文：本文を範囲選択してルビや傍点を付けられる。すでにルビのある所を選ぶと、いまの読みが入った入力欄が出て直せる。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/rubyEmphasisScene.promo.ts`
 */
import type { Frame } from "playwright-core";
import { test } from "vitest";
import { selectText, openEpisode } from "../support/manuscriptFrame";
import { answerInput, waitForQuickInput } from "../support/quickInput";
import { waitUntil } from "../support/wait";
import { recordFeature } from "./support/featureScene";

const EPISODE = "001_雨の駅.md";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　ミナは切符を握ったまま、坂の上を見上げる。",
  "　改札の向こうに、白い傘が揺れている。",
  "",
].join("\n");

test("ルビと傍点の広報素材を撮る", async () => {
  let frame!: Frame;
  await recordFeature({
    name: "ruby-emphasis",
    subtitle: "ルビと傍点 — 選んで付ける",
    workTitle: "雨の駅",
    episodes: [{ name: EPISODE, text: TEXT }],
    snapAt: 11.5,
    open: async ({ page }) => {
      frame = await openEpisode(page, EPISODE, "揺れている");
      await page.mouse.move(640, 690);
    },
    play: async ({ page }, caption) => {
      await caption("付けたい語を選んで、［ルビ］を押す");
      await selectText(frame, "切符");
      await page.waitForTimeout(1_500);
      await frame.locator("#ruby").click();
      await waitForQuickInput(page, "「切符」の読み");
      await page.waitForTimeout(1_200);
      await answerInput(page, "きっぷ");
      await waitUntil(async () => (await frame.locator("#compose ruby").count()) > 0, "ルビが組まれる", 15_000);
      await caption("振り仮名として組まれる");
      await page.waitForTimeout(2_800);
      await selectText(frame, "白い傘");
      await caption("傍点も、選んで［傍点］を押すだけ");
      await page.waitForTimeout(1_200);
      await frame.locator("#emph").click();
      await waitUntil(async () => (await frame.locator("#compose .emphasis").count()) > 0, "傍点が付く", 15_000);
      await page.waitForTimeout(3_500);
    },
  });
});
