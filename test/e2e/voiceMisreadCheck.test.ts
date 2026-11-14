/**
 * 命令「読み間違いを調べる」（画面の自動テスト、設計書6.42.5・6.113。作者の決定 2026-11-14 夜）。
 *
 * 見張ること：
 * 1. 第1話でルビを振った「灯里」を、第2話でルビなしに書く。偽のエンジンは「灯里」を「ヒ」と読む
 * 2. 第2話を原稿エディターで開いてパレットから「読み間違いを調べる」を押すと、校正・メモパネルが開き、
 *    「読み間違いの見込み」の行（エンジンの読み「ヒ」・正しい読み「あかり」・第1話のルビ）が並ぶ
 * 3. 行に［読みの辞書へ足す］［ここにルビを振る］［見送る］がある
 * 4. エンジンへ頼んだのは audio_query だけ（音声は作らない）。本文は書き換えない
 *
 * **本物のエンジンは起こさない。** 偽のエンジン（`support/fakeVoiceEngine.ts`）を 127.0.0.1 に立て、語ごとの読みを返させる。
 * **AI は呼ばない。** 判定の中身（かなのならし・読みが2つある語など）は単体テスト（`unit/core/readingMisread.test.ts`）が見ている。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { closedEngineUrl, startFakeVoiceEngine, voiceEngineSettings } from "./support/fakeVoiceEngine";
import { memoPanelFrame, openEpisode } from "./support/manuscriptFrame";
import { runCommand } from "./support/quickInput";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { notificationTexts } from "./support/workbenchDom";

const FIRST = "001_はじまり.txt";
const SECOND = "002_つづき.txt";
const FIRST_TEXT = "　｜灯里《あかり》が笑った。\n";
const SECOND_TEXT = "　灯里は走った。\n";

test("「読み間違いを調べる」で、校正・メモパネルに読み間違いの見込みの行が出る（音声は作らない）", async () => {
  const fake = await startFakeVoiceEngine({ brand: "AivisSpeech", readings: { 灯里: "ヒ", 走: "ハシ", 笑: "ワラ" } });
  try {
    await withVsCode(
      "読み間違いを調べる",
      [
        { name: FIRST, text: FIRST_TEXT },
        { name: SECOND, text: SECOND_TEXT },
      ],
      async (session) => {
        const { page } = session;
        await openEpisode(page, SECOND, "灯里は走った");
        await runCommand(page, "読み間違いを調べる");

        let body = "";
        await waitUntil(
          async () => {
            const frame = await memoPanelFrame(page);
            body = frame ? await frame.evaluate(() => document.body.innerText) : "";
            return body.includes("読み間違いの見込み") && body.includes("「ヒ」");
          },
          "校正・メモパネルに読み間違いの見込みの行が出る",
          60_000
        ).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}（パネル：${JSON.stringify(body.slice(0, 400))}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`
          );
        });
        expect(body).toContain("「灯里」を、声のエンジンは「ヒ」と読みそうです");
        expect(body).toContain("正しい読みは「あかり」（第1話のルビ）");

        const frame = await memoPanelFrame(page);
        const buttons = frame
          ? await frame.evaluate(() => Array.from(document.querySelectorAll("button"), (button) => button.textContent ?? ""))
          : [];
        expect(buttons).toContain("読みの辞書へ足す");
        expect(buttons).toContain("ここにルビを振る");
        expect(buttons).toContain("見送る");

        // 頼んだのは読み方の下ごしらえだけ（音声は作らない）
        expect(fake.requests.some((request) => request.path === "/synthesis")).toBe(false);
        expect(fake.requests.some((request) => request.path === "/audio_query")).toBe(true);
        // 本文は書き換えない
        expect(await readFile(path.join(session.manuscriptFolder, SECOND), "utf8")).toBe(SECOND_TEXT);
      },
      { settings: voiceEngineSettings({ aivisspeech: fake.url, voicevox: await closedEngineUrl() }) }
    );
  } finally {
    await fake.close();
  }
}, 240_000);
