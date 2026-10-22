/**
 * Discord「機能紹介」用の広報素材：更新SNS告知文作成（作者の依頼 2026-10-22）。
 * features.md の文：ネタバレしない告知文を3種（X用・活動報告／近況ノート用・後書き用）作る。貼るのは作者で、サイトへ自動で書き込まない。
 *
 * **本物のAIは呼ばない。** 偽の Ollama が、告知文のスキーマに合う答えを返す。
 * コピーのボタンは押さない（作者のクリップボードに触れないため）。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/snsAnnounceScene.promo.ts`
 */
import { test } from "vitest";
import { passLocalAiGate } from "../support/fakeOllama";
import { answerInput, runCommand, waitForQuickInput } from "../support/quickInput";
import { waitUntil } from "../support/wait";
import { notificationTexts, pickQuickPickRow, quickPickRows } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

const EPISODE = "002_白い傘.txt";

const ANSWER = JSON.stringify({
  xPost: "「雨の駅」第2話を更新しました。雨の夜、駅員が差し出したのは、一本の白い傘。ミナは朝を待ちます。",
  activityReport:
    "「雨の駅」第2話「白い傘」を公開しました。静かな夜の待合室が舞台です。ゆっくり読んでいただければ幸いです。次回もよろしくお願いします。",
  afterword: "雨の音を聞きながら書いた回です。ミナの小さな変化を、見守っていただければ嬉しいです。",
  spoilerCheck: "結末や、まだ明かされていない事実には触れていません",
  confidence: "high",
});

test("更新SNS告知文作成の広報素材を撮る", async () => {
  await recordFeature({
    name: "sns-announce",
    subtitle: "更新SNS告知文作成 — ネタバレなしの告知文を3種",
    workTitle: "雨の駅",
    episodes: [
      { name: "001_雨の駅.txt", text: "　終電を逃したミナは、駅員の宗次に声をかけられた。\n" },
      { name: EPISODE, text: "　宗次は傘を差し出した。ミナは待合室で朝を待った。雨は夜通し降り続いていた。\n" },
    ],
    fakeAnswer: () => ANSWER,
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    snapAt: 14,
    play: async ({ page }, caption) => {
      await caption("更新したら、ネタバレしない告知文を作る");
      await page.waitForTimeout(2_000);
      await runCommand(page, "更新SNS告知文作成");
      // 告知の設定（初回だけ）：ハッシュタグ → 作品ページのURL（作り物）
      await waitForQuickInput(page, "の告知に付けるハッシュタグ", 30_000);
      await page.waitForTimeout(1_000);
      await answerInput(page, "創作 小説");
      await waitForQuickInput(page, "の作品ページのURL", 15_000);
      await answerInput(page, "https://example.com/ame-no-eki");
      await waitForQuickInput(page, "の更新告知", 15_000);
      await page.waitForTimeout(1_500);
      await pickQuickPickRow(page, EPISODE);
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const rows = await quickPickRows(page);
          if (!rows.some((row) => row.label.includes("更新告知文を作ります"))) return false;
          await pickQuickPickRow(page, "実行");
          return true;
        },
        "処理量の確認が出て［実行］で進む",
        30_000
      );
      await caption("X用・活動報告用・後書き用の3種ができる");
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await notificationTexts(page)).some((text) => text.includes("更新告知文ができました"));
        },
        "告知文ができた知らせが出る",
        60_000
      );
      await page.waitForTimeout(2_000);
      // 3種が見えるところまで、文書を下へ送る
      await page.mouse.move(640, 300);
      await page.mouse.wheel(0, 520);
      await page.waitForTimeout(2_000);
      await caption("貼るのは作者。サイトへは自動で書き込まない");
      await page.waitForTimeout(3_000);
    },
  });
});
