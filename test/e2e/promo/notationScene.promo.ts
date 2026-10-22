/**
 * Discord「機能紹介」用の広報素材：表記ゆれ検知（作者の依頼 2026-10-22）。
 * features.md の文：「良い／よい」のような揺れを作品全体から探す（AIを使わない）。どちらに揃えるかを選ぶと、少数派の箇所が提案パネルに並ぶ。原稿エディターでは Ctrl+Alt+H。
 *
 * **AIは呼ばない。** 偽の Ollama は立てるが、答えさせる場面は無い。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/notationScene.promo.ts`
 */
import { test } from "vitest";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { proposalPanelFrame } from "../support/sampleFinding";
import { waitUntil } from "../support/wait";
import { acceptQuickPick, clearNotifications, pickQuickPickRow, quickPickRows, quickPickTitle, toggleQuickPickRow } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

const EP1 = "001_雨の駅.txt";
const EP2 = "002_朝の窓口.txt";
const TEXT1 = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　待合室の灯りは良い具合に暗く、ベンチは座り心地が良い。",
  "　売店の老人は、天気が良いうちに帰れと笑った。",
  "　零時を指した時計の音が、耳に良い。",
  "",
].join("\n");
const TEXT2 = [
  "　翌朝の窓口で、駅員は機嫌がよいと言った。",
  "　切符の席は、窓際のよい場所だった。",
  "　改札の外には、見晴らしの良い坂が続いていた。",
  "",
].join("\n");

test("表記ゆれ検知の広報素材を撮る", async () => {
  await recordFeature({
    name: "notation-check",
    subtitle: "表記ゆれ検知 — 「良い／よい」を作品全体から探す",
    workTitle: "雨の駅",
    episodes: [
      { name: EP1, text: TEXT1 },
      { name: EP2, text: TEXT2 },
    ],
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    snapAt: 11,
    open: async ({ page }) => {
      await openEpisode(page, EP1, "零時を指した");
    },
    play: async ({ page }, caption) => {
      await caption("原稿エディターで Ctrl+Alt+H。AIを使わずに探す");
      const frame = await openEpisode(page, EP1, "零時を指した");
      await placeCaretAfter(frame, "終電を逃した");
      await page.waitForTimeout(800);
      await page.keyboard.press("Control+Alt+KeyH");
      await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("表記ゆれが"), "揺れの組が並ぶ", 30_000);
      await page.waitForTimeout(1_500);
      const rows = await quickPickRows(page);
      const target = rows.find((row) => row.label.includes("良い"))?.label ?? rows[0].label;
      await caption("見つかった揺れから、揃えたい組を選ぶ");
      await toggleQuickPickRow(page, target);
      await page.waitForTimeout(1_500);
      await acceptQuickPick(page);
      await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("どちらに揃えますか"), "揃え先を訊かれる", 15_000);
      await caption("どちらに揃えるかを選ぶ");
      await page.waitForTimeout(1_500);
      const choices = await quickPickRows(page);
      const form = choices.find((row) => row.label.includes("「良い」に揃える")) ?? choices[0];
      await pickQuickPickRow(page, form.label);
      await clearNotifications(page);
      let memo = await memoPanelFrame(page);
      await waitUntil(
        async () => {
          memo = await memoPanelFrame(page);
          return memo !== undefined && (await memo.locator("button.go").count()) > 0;
        },
        "校正・メモパネルに指摘が並ぶ",
        30_000
      );
      await caption("少数派の箇所が、一覧に並ぶ");
      await page.waitForTimeout(2_000);
      await (memo as NonNullable<typeof memo>).locator("button", { hasText: "提案パネル" }).first().click();
      let panel = await proposalPanelFrame(page);
      await waitUntil(
        async () => {
          panel = await proposalPanelFrame(page);
          return panel !== undefined && (await panel.locator('[data-action="apply"]').count()) > 0;
        },
        "提案パネルに少数派の箇所が並ぶ",
        30_000
      );
      await caption("提案パネルで、1件ずつ確認する");
      await page.waitForTimeout(3_500);
    },
  });
});
