/**
 * Discord「機能紹介」用の広報素材：誤字脱字・推敲・矛盾などの検知（作者の依頼 2026-10-22）。
 * features.md の文：候補を「提案」パネルに並べ、1件ずつ確認して適用する。原稿エディターでは Ctrl+Alt+T で、その話の誤字脱字を検知できる。
 *
 * **本物のAIは呼ばない。** 偽の Ollama が、誤字脱字の形（issues）で「以外→意外」を1件返す。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/detectionScene.promo.ts`
 */
import { test } from "vitest";
import { passLocalAiGate } from "../support/fakeOllama";
import { composeText, manuscriptFrames, memoPanelFrame, openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { proposalPanelFrame } from "../support/sampleFinding";
import { waitUntil } from "../support/wait";
import { clearNotifications, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

const EPISODE = "001_雨の駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　近づいてみると、男は以外にも若かった。",
  "　ホームの時計が、零時を指していた。",
  "",
].join("\n");

const ANSWER = JSON.stringify({
  issues: [{ line: 2, original: "男は以外にも若かった。", target: "以外", suggestion: "意外", reason: "誤変換", confidence: "high" }],
});

test("誤字脱字・推敲・矛盾などの検知の広報素材を撮る", async () => {
  await recordFeature({
    name: "detection",
    subtitle: "誤字脱字・推敲・矛盾などの検知 — 提案を1件ずつ確認",
    workTitle: "雨の駅",
    episodes: [{ name: EPISODE, text: TEXT }],
    fakeAnswer: () => ANSWER,
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    snapAt: 12,
    open: async ({ page }) => {
      await openEpisode(page, EPISODE, "零時を指していた");
    },
    play: async ({ page }, caption) => {
      await caption("原稿エディターで Ctrl+Alt+T。この話の誤字脱字を検知する");
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");
      await page.waitForTimeout(800);
      await page.keyboard.press("Control+Alt+KeyT");
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const title = (await quickPickTitle(page)) ?? "";
          const rows = await quickPickRows(page);
          const text = [title, ...rows.map((row) => row.label)].join("\n");
          if (!text.includes("件を処理します")) return false;
          await page.waitForTimeout(800);
          await page.keyboard.press("Enter");
          return true;
        },
        "量の確認に答える",
        30_000
      );
      await caption("AIの指摘が、一覧に並ぶ");
      let memo = await memoPanelFrame(page);
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          memo = await memoPanelFrame(page);
          return memo !== undefined && (await memo.locator("button.go").count()) > 0;
        },
        "校正・メモパネルに指摘が並ぶ",
        90_000
      );
      await clearNotifications(page);
      await page.waitForTimeout(2_500);
      await caption("提案パネルで、1件ずつ確認する");
      await (memo as NonNullable<typeof memo>).locator("button", { hasText: "提案パネル" }).first().click();
      let panel = await proposalPanelFrame(page);
      await waitUntil(
        async () => {
          panel = await proposalPanelFrame(page);
          return panel !== undefined && (await panel.locator('[data-action="apply"]').count()) > 0;
        },
        "提案パネルに指摘が並ぶ",
        30_000
      );
      await page.waitForTimeout(2_500);
      await caption("確認して、適用する");
      await page.waitForTimeout(1_500);
      await (panel as NonNullable<typeof panel>).locator('[data-action="apply"]').first().click();
      await waitUntil(
        async () => {
          for (const candidate of await manuscriptFrames(page)) {
            if ((await composeText(candidate)).includes("男は意外にも若かった")) return true;
          }
          return false;
        },
        "本文が「意外」に直る",
        15_000
      );
      await page.waitForTimeout(2_500);
    },
  });
});
