/**
 * Discord「機能紹介」用の広報素材：AI設定（作者の依頼 2026-10-22）。
 * features.md の文：Ollama・LM Studio・Gemini・さくらのAI・ChatGPT・Claude から選べる。コマンドパレットの「小説執筆: AI設定」から開く。
 *
 * **鍵の欄は開かない**（クラウドAIは一覧に名前が出るだけ。選ぶのは手元の Ollama）。偽の Ollama のモデル名は実在の名前にする。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/aiSettingsScene.promo.ts`
 */
import { test } from "vitest";
import { runCommand, waitForQuickInput } from "../support/quickInput";
import { waitUntil } from "../support/wait";
import { pickQuickPickRow, quickPickTitle } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

test("AI設定の広報素材を撮る", async () => {
  await recordFeature({
    name: "ai-settings",
    subtitle: "AI設定 — 使うAIを選ぶ",
    workTitle: "雨の駅",
    episodes: [{ name: "001_雨の駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n" }],
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    snapAt: 5,
    open: async ({ page }) => {
      await runCommand(page, "AI設定");
      await waitForQuickInput(page, "使用するAIを選んでください");
    },
    play: async ({ page }, caption) => {
      await caption("手元のAIも、クラウドのAIも選べる");
      await page.waitForTimeout(5_500);
      await caption("たとえば手元の Ollama を選ぶと");
      await page.waitForTimeout(1_200);
      await pickQuickPickRow(page, "Ollama（ローカル）");
      await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("使用するモデルを選んでください"), "モデルの一覧が出る", 30_000);
      await caption("入っているモデルの一覧から選べる");
      await page.waitForTimeout(5_500);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    },
  });
});
