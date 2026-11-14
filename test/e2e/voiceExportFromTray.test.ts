/**
 * 原稿エディターの［出力］→［音声に書き出す］（画面の自動テスト、設計書6.25.13・6.42.4・6.113。
 * 作者の依頼「朗読音声のファイル保存をエディターのメニューにたしてください」）。
 *
 * 見張ること：
 * 1. ［出力］の段に［音声に書き出す］が並ぶ（［PDF（この話）］の隣）
 * 2. 読み上げの段で人物の声（AivisSpeech）を選んだうえで［出力］のこのボタンを押すと、
 *    列の［音声に書き出す］と同じ書き出しの確認の窓（「…を人物の声で音声（MP3）に書き出します」・置き場）が出る。
 *    確認で答える前は、本文を合成へ送らない。窓は［キャンセル］で閉じ、何も作らない
 *
 * **本物のエンジンは起こさない。** 偽のエンジン（`support/fakeVoiceEngine.ts`）を 127.0.0.1 に立てる。
 * **AI は呼ばない。** 書き出しの中身（MP3・注意書き）は voiceEngineChoiceFlow が見ている。
 */
import { expect, test } from "vitest";
import {
  closedEngineUrl,
  FAKE_ACML_TEXT,
  fakeAivmModels,
  startFakeVoiceEngine,
  textCarrying,
  voiceEngineSettings,
} from "./support/fakeVoiceEngine";
import { clickToolButton, openEpisode } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { notificationTexts, quickInputWaitContext, quickPickRows, quickPickTitle } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const EPISODE_STEM = "001_はじまり";
const SHORT_TEXT = "　朝の駅は静かだった。\n「おはよう」と彼女が言った。\n";

test("［出力］の［音声に書き出す］を押すと、列のボタンと同じ書き出しの確認の窓が出る（確認の前は合成しない）", async () => {
  const fake = await startFakeVoiceEngine({
    brand: "AivisSpeech",
    terms: {
      aivmModels: fakeAivmModels({ mai: FAKE_ACML_TEXT, kanon: FAKE_ACML_TEXT }),
      policies: { "uuid-mai": "まいの話者の規約", "uuid-kanon": "花音の話者の規約" },
    },
  });
  try {
    await withVsCode(
      "［出力］から音声に書き出す",
      [{ name: EPISODE, text: SHORT_TEXT }],
      async (session) => {
        const { page } = session;
        const frame = await openEpisode(page, EPISODE, "朝の駅は静かだった");
        // 読み上げの段で人物の声を選ぶ（拡張機能が使えると知らせるまで待つ）
        await clickToolButton(frame, "aloudToggle");
        await waitUntil(
          async () => (await frame.locator('#aloudEngine option[value="aivisspeech"]').isDisabled().catch(() => true)) === false,
          "［声］で人物の声が選べる",
          20_000
        );
        await frame.locator("#aloudEngine").selectOption("aivisspeech");
        await waitUntil(async () => !(await frame.locator("#aloudPlay").isDisabled()), "［▶ 読む］が押せる", 20_000);

        // ［出力］の段を開いて押す（clickToolButton が段を開く）。ボタンは［PDF（この話）］と同じ段にある
        const tray = await frame.evaluate(() => document.getElementById("exportVoice")?.closest(".tray")?.getAttribute("data-tray") ?? "");
        expect(tray, "［音声に書き出す］が［出力］の段にある").toBe("output");
        await clickToolButton(frame, "exportVoice");

        let text = "";
        await waitUntil(
          async () => {
            const rows = (await quickPickRows(page)).map((row) => row.label);
            text = [(await quickPickTitle(page)) ?? "", ...rows].join("\n");
            return text.includes("を人物の声で音声（MP3）に書き出します");
          },
          "［出力］の［音声に書き出す］で書き出しの確認の窓が出る",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
        });
        expect(text, `確認の窓：${text}`).toContain(`.aiwriter/exports/音声/${EPISODE_STEM}`);
        // 確認で答える前は、本文を合成へ送らない
        expect(textCarrying(fake).filter((request) => request.path === "/synthesis"), "確認の前に合成しました").toHaveLength(0);
        // 閉じる（書き出さない）
        await page.keyboard.press("Escape");
      },
      { settings: voiceEngineSettings({ aivisspeech: fake.url, voicevox: await closedEngineUrl() }) }
    );
  } finally {
    await fake.close();
  }
}, 240_000);
