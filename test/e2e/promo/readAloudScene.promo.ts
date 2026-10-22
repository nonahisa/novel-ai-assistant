/**
 * Discord「機能紹介」用の広報素材：読み上げ（音読推敲）（作者の依頼 2026-10-22）。
 * features.md の文：OSの音声で本文を読み上げ、読んでいる文が光る。［⚑ 引っかかった］で、その文の前にメモを残して一時停止する。
 * 音は録れないので、面の中の声を偽物（読む文を控えるだけ）に替える。光る様子と、メモが入る様子だけを撮る。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/readAloudScene.promo.ts`
 */
import type { Frame } from "playwright-core";
import { test } from "vitest";
import { composeText, openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { waitUntil } from "../support/wait";
import { recordFeature } from "./support/featureScene";

const EPISODE = "001_雨の駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　傘を持たない彼女は、時計の針ばかりを見つめている。",
  "　改札の向こうで、見知らぬ男が手を振っていた。",
  "",
].join("\n");

async function installFakeVoice(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    const fake = {
      speaking: false,
      paused: false,
      getVoices: () => [{ name: "日本語の声", lang: "ja-JP" }],
      speak: () => undefined,
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      addEventListener: () => undefined,
    };
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true, writable: true });
    Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
  });
}

test("読み上げの広報素材を撮る", async () => {
  let frame!: Frame;
  await recordFeature({
    name: "read-aloud",
    subtitle: "読み上げ — 耳で推敲する",
    workTitle: "雨の駅",
    episodes: [{ name: EPISODE, text: TEXT }],
    snapAt: 7,
    open: async ({ page }) => {
      frame = await openEpisode(page, EPISODE, "手を振っていた");
      await installFakeVoice(frame);
      await frame.locator("#aloudToggle").click();
      await waitUntil(async () => !(await frame.locator("#aloudPlay").isDisabled()), "［▶ 読む］が押せる", 15_000);
      await placeCaretAfter(frame, "終電を逃した");
      await page.mouse.move(640, 690);
    },
    play: async ({ page }, caption) => {
      await caption("本文を読み上げ、読んでいる文が光る");
      await page.waitForTimeout(1_500);
      await frame.locator("#aloudPlay").click();
      await page.waitForTimeout(4_500);
      await caption("引っかかったら、［⚑ 引っかかった］");
      await waitUntil(async () => !(await frame.locator("#aloudMark").isDisabled()), "［⚑］が押せる", 10_000);
      await frame.locator("#aloudMark").click();
      await waitUntil(async () => (await composeText(frame)).includes("音読：ここで引っかかった"), "メモが入る", 15_000);
      await caption("その文の前にメモを残して、一時停止する");
      await page.waitForTimeout(4_500);
    },
  });
});
