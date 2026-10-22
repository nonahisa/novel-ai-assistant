/**
 * Discord「機能紹介」用の広報素材：設定資料の一括抽出（作者の依頼 2026-10-22）。
 * features.md の文：全話から登場人物・能力・組織・場所・世界観をまとめて取り出し、設定資料を作る。
 *
 * **本物のAIは呼ばない。** 偽の Ollama が、抽出のスキーマに合う答えを返す（extractCompletionNotices.test.ts と同じ形）。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/bulkExtractScene.promo.ts`
 */
import { test } from "vitest";
import { passLocalAiGate } from "../support/fakeOllama";
import { runCommand } from "../support/quickInput";
import { waitUntil } from "../support/wait";
import { notificationTexts, pickQuickPickRow, quickOpen, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

const EPISODES = [
  {
    name: "001_雨の駅.txt",
    text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n　ミナは切符を握ったまま、坂の上を見上げる。\n「お客さん、もう電車はありませんよ」\n　駅員の宗次が、改札の向こうから声をかけた。\n",
  },
  {
    name: "002_白い傘.txt",
    text: "　宗次は傘を差し出した。ミナは雨の駅の待合室で、朝を待つことにした。\n「ありがとうございます」\n　雨は夜通し降り続いていた。\n",
  },
];

function person(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    entityType: "person",
    aliases: [],
    isMob: false,
    reading: null,
    summary: null,
    gender: null,
    affiliation: null,
    role: null,
    personality: null,
    appearance: null,
    speechStyle: null,
    speechEvidence: null,
    firstPerson: null,
    defaultSecondPerson: null,
    addressTerms: [],
    relations: [],
    ...fields,
  };
}

const ANSWER = JSON.stringify({
  characters: [
    person({ name: "ミナ", role: "終電を逃した乗客", summary: "切符を握って坂の上を見上げる", evidence: "ミナは切符を握ったまま、坂の上を見上げる" }),
    person({ name: "宗次", role: "駅員", summary: "改札から声をかけ、傘を貸す", evidence: "駅員の宗次が、改札の向こうから声をかけた" }),
  ],
  abilities: [],
  organizations: [],
  locations: [{ name: "雨の駅", aliases: [], reading: null, summary: "終電後も雨が残る駅", region: null, description: "改札と待合室がある小さな駅", relations: [], evidence: "ミナは雨の駅の待合室で、朝を待つことにした" }],
  worldview: [],
  abilitySystem: { abilityTerm: null, description: null, rules: [] },
  confidence: "high",
});

test("設定資料の一括抽出の広報素材を撮る", async () => {
  await recordFeature({
    name: "bulk-extract",
    subtitle: "設定資料の一括抽出 — 全話からまとめて取り出す",
    workTitle: "雨の駅",
    episodes: EPISODES,
    fakeAnswer: () => ANSWER,
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    snapAt: 13.5,
    keybindings: [{ key: "ctrl+alt+shift+f8", command: "workbench.action.reopenTextEditor" }],
    open: async ({ page }) => {
      await quickOpen(page, "001_雨の駅.txt");
      await page.keyboard.press("Control+Alt+Shift+F8");
      await page.waitForTimeout(1_000);
    },
    play: async ({ page }, caption) => {
      await caption("全話から、登場人物や場所をまとめて取り出す");
      await page.waitForTimeout(2_500);
      await runCommand(page, "一括抽出");
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return ((await quickPickTitle(page)) ?? "") !== "";
        },
        "抽出の画面が出る",
        30_000
      );
      // 処理量の確認が出たら［実行］で進む（出なければ、そのまま走っている）
      await page.waitForTimeout(2_500);
      const rows = await quickPickRows(page);
      if (rows.some((row) => row.label === "実行")) await pickQuickPickRow(page, "実行");
      await caption("AIが読んで、設定資料にまとめていく");
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const texts = await notificationTexts(page);
          return texts.some((text) => text.includes("新規 ") && text.includes("保存済み "));
        },
        "完了の報告が出る",
        120_000
      );
      await caption("できた分は、設定資料に保存される");
      await page.waitForTimeout(3_000);
      await page.getByText("設定資料を見る").first().click();
      await page.waitForTimeout(3_500);
    },
  });
});
