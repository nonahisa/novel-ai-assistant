/**
 * Discord「機能紹介」用の広報素材：AIに相談する（作者の依頼 2026-10-22）。
 * features.md の文：いま開いているファイルについて、日本語で質問できる。原稿エディターの Ctrl+Alt+C から始められる。
 *
 * **本物のAIは呼ばない。** 偽の Ollama が相談の答えの形（WORK_CHAT_SCHEMA）で、答えと次の問いの選択肢を返す。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/aiConsultScene.promo.ts`
 */
import type { Frame, Page } from "playwright-core";
import { test } from "vitest";
import { chatAnswer, SEARCH_TERMS_ANSWER } from "../support/chatAnswerButtons";
import { sendChatQuestion } from "../support/chatInput";
import { passLocalAiGate } from "../support/fakeOllama";
import { openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { waitUntil } from "../support/wait";
import { recordFeature } from "./support/featureScene";

const EPISODE = "001_雨の駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　ベンチには、傘を持たない女が座っていた。",
  "　ホームの時計が、零時を指していた。",
  "",
].join("\n");

const QUESTION = "この場面は、どんな雰囲気に読めますか";
const REPLY = "静かで、少し心細い雰囲気に読めます。雨の音だけが残るホームと、傘を持たない女が、ひとりきりの夜を感じさせます。零時の時計が、これから何かが始まる気配も添えています。";
const OPTIONS = ["心細さをもう少し強めたい", "女の人物像を足したい"];

/** 相談の面（入力欄と［送る］と会話欄を持つ。横でも大きい画面でも同じ ID） */
async function chatFrame(page: Page, marker: "to-main" | "to-sub"): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate((id) => document.getElementById("context-what") !== null && document.getElementById(id) !== null, marker)
      .catch(() => false);
    if (found) return frame;
  }
  return undefined;
}

test("AIに相談するの広報素材を撮る", async () => {
  await recordFeature({
    name: "ai-consult",
    subtitle: "AIに相談する — 開いている原稿について、日本語で質問",
    workTitle: "雨の駅",
    episodes: [{ name: EPISODE, text: TEXT }],
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    fakeAnswer: (request) => {
      if (request.user.startsWith("次の質問に合う場面を")) return SEARCH_TERMS_ANSWER;
      if (request.user.includes(QUESTION)) return chatAnswer({ reply: REPLY, options: OPTIONS });
      return chatAnswer({ reply: "偽のAIの答えです。" });
    },
    keybindings: [{ key: "ctrl+alt+shift+h", command: "novelai.openChatPanel" }],
    snapAt: 7.5,
    open: async ({ page }) => {
      await openEpisode(page, EPISODE, "零時を指していた");
    },
    play: async ({ page }, caption) => {
      await caption("「AIに相談」を開く");
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");
      await page.waitForTimeout(800);
      // 大きい画面で見せる（試験用に割り当てたキーで開く。画面は［メインに表示］と同じ大きい相談画面）
      await page.keyboard.press("Control+Alt+Shift+KeyH");
      let chat: Frame | undefined;
      await waitUntil(
        async () => {
          chat = await chatFrame(page, "to-sub");
          return chat !== undefined && (await chat.locator("#send").isVisible().catch(() => false));
        },
        "大きい相談画面が開く",
        30_000
      );
      const room = chat as Frame;
      await page.waitForTimeout(1_500);
      await caption("いま開いている原稿について、日本語で質問する");
      await sendChatQuestion(room, QUESTION, "相談の画面");
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await room.evaluate(() => document.getElementById("log")?.textContent ?? "")).includes("静かで、少し心細い");
        },
        "答えが出る",
        60_000
      );
      await caption("答えと、続きの問いの選択肢が返る");
      await page.waitForTimeout(4_000);
    },
  });
});
