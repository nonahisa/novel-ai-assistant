/**
 * `.md` の第1話（カクヨム形式の頭の欄つき）で、カーソルを【公開状態】の行に置いて［▶ 読む］を押すと、
 * 題から読み、公開状態・日時・文字数の欄の字を読まない（画面の自動テスト。設計書6.42。実機確認リスト 79行〔0.147.1〕。
 * 作者の答え 2026-11-08「題と本文だけを読む」。ノートPCでの食い違いは版の取り違えの見込み）。
 *
 * 偽の音声エンジン（`support/fakeVoiceEngine.ts`）へ届いた本文で確かめる：最初に合成を頼まれる文が題
 * 「第一話　はじまり」で、頭の欄の字（公開状態・下書き・日時・文字数）はどの頼みにも入らない。
 * 見本の話はこの台本の中で作る（作者の原稿は使わない）。題は漢数字で書く（半角数字は組んで書く面で縦中横の
 * 印に包まれ、字の節点が分かれる）。
 *
 * **作者の手に残すもの**：本物のエンジンで聞いて、読み上げの声が題から始まるか（耳）。**AI は呼ばない。**
 */
import { expect, test } from "vitest";
import { describeVoiceRequests, startFakeVoiceEngine, textCarrying, closedEngineUrl, voiceEngineSettings } from "./support/fakeVoiceEngine";
import { placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { chooseEngine, openReadingRow, stopReading } from "./support/voiceReadingUi";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.md";
const TEXT = [
  "【タイトル】",
  "第一話　はじまり",
  "",
  "【公開状態】",
  "下書き",
  "",
  "【作成日時】",
  "2026-11-01 10:00:00（+09:00）",
  "",
  "【公開日時】",
  "",
  "",
  "【更新日時】",
  "2026-11-08 09:00:00（+09:00）",
  "",
  "【文字数】",
  "5,529文字",
  "",
  "【前書き】",
  "読んでくださってありがとうございます。",
  "",
  "【本文（3行）】",
  "朝が来た。灯は窓を開けた。",
  "「行こう」と蓮は言った。",
  "",
  "【後書き】",
  "次回もお楽しみに。",
  "",
].join("\n");

test("カクヨム形式の .md で、カーソルを【公開状態】の行に置いて［▶ 読む］と、題から読み、頭の欄の字は頼まれない", async () => {
  const engine = await startFakeVoiceEngine({ brand: "AivisSpeech" });
  try {
    await withVsCode(
      "頭の欄を読まない",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const frame = await openReadingRow(session, EPISODE, "朝が来た");
        await chooseEngine(frame, "aivisspeech");
        // 頭の欄（読まない所）の中にカーソルを置く
        await placeCaretAfter(frame, "【公開状態】");
        await frame.locator("#aloudPlay").click();
        // 題と本文の最初の文が頼まれるまで（先読みで続く文も届く）
        await waitUntil(
          async () => {
            const sent = textCarrying(engine).map((request) => request.text);
            return sent.some((text) => text.includes("はじまり")) && sent.some((text) => text.includes("朝が来た"));
          },
          "題と本文の文が合成へ頼まれる",
          30_000
        ).catch((error: unknown) => {
          throw new Error(`${String(error)}（偽のエンジンへの頼み：${describeVoiceRequests(engine)}）`);
        });
        await stopReading(frame);

        const sent = textCarrying(engine).map((request) => request.text);
        // 最初に頼む文は題
        expect(sent[0], `最初の頼み：${JSON.stringify(sent.slice(0, 4))}`).toContain("第一話");
        expect(sent[0], `最初の頼み：${JSON.stringify(sent.slice(0, 4))}`).toContain("はじまり");
        // 頭の欄・前書き・後書きの字はどの頼みにも入らない
        const all = sent.join("\n");
        for (const word of ["公開状態", "下書き", "作成日時", "公開日時", "更新日時", "2026", "文字数", "5,529", "ありがとう", "お楽しみ"]) {
          expect(all, `「${word}」が合成へ頼まれました：${JSON.stringify(sent)}`).not.toContain(word);
        }
      },
      { settings: voiceEngineSettings({ aivisspeech: engine.url, voicevox: await closedEngineUrl() }) }
    );
  } finally {
    await engine.close();
  }
}, 240_000);
