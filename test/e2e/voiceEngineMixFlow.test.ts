/**
 * 人物ごとに声のエンジンを混ぜる（画面の自動テスト。設計書6.42.3・6.42.4・6.113。0.151.0 の実機確認リスト
 * 「人物の声のエンジンを人物ごとに混ぜる」の5項目のうち、押して起きることを機械へ移す。2026-11-12）。
 *
 * 偽のエンジンを2つ立てる（`support/fakeVoiceEngine.ts`。VOICEVOX 役と AivisSpeech 役）。語り手は AivisSpeech の声、
 * 灯は VOICEVOX の声に割り当てた作品で（`voices.json` に engine の印つきで置く）、
 *
 * 1. 両方が動いているとき、［声］を AivisSpeech にして［▶ 読む］と、灯の台詞の頼みだけが VOICEVOX 役の偽へ、
 *    ほかは AivisSpeech 役の偽へ届く（リスト26行）。エンジンが替わる所の間の長さは、頼みの時刻を記録するだけで
 *    良し悪しは見ない（鳴り始めの時刻は画面から取れない。聞いての間は作者の耳）
 * 2. 両方が動いているとき、［音声に書き出す］→［書き出す］で、両方の偽への合成の頼み（`/synthesis` の本文）の
 *    `outputSamplingRate` が 44100 になり、MP3 ができ、「クレジットと利用条件.txt」に AivisSpeech の声と
 *    「VOICEVOX:花音」が並ぶ（28行）
 * 3. VOICEVOX を読んでいる途中に止めると、真ん中の窓に「…（VOICEVOX）に繋がりませんでした。」と
 *    「AivisSpeech（…）が動いています。こちらで読みますか。」が出て、［AivisSpeech で読む］で［声］が替わり、
 *    灯の台詞は代わりの声で AivisSpeech へ頼まれ、右下の一言は1回だけ（29行）
 * 4. AivisSpeech だけが動いているとき、［声の割り当て］の選ぶ窓の入力欄の薄い字（placeholder）に
 *    「VOICEVOX に繋がらないので、VOICEVOX の声は並んでいません（…）。」が出る（30行）
 *
 * リストの27行（VOICEVOX を閉じたまま読むと止まらず、灯の台詞も AivisSpeech 役へ代わりの声で頼み、一言は1回）は、
 * `voiceEngineChoiceFlow.test.ts` の「VOICEVOX で選んだ声の人物がいる作品を、VOICEVOX を閉じたまま AivisSpeech で
 * 読むと…」が同じことを見ているので重ねて書かない。
 *
 * **作者の手に残すもの**：声の高さ・速さ・読み分けて聞こえるか・エンジンが替わる所の間が空きすぎないか（耳）・
 * 本物のエンジンで同じことが起きるか。本物のエンジンは起こさない。**AI は呼ばない。**
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { VOICE_ENGINE_LABEL, voiceEngineDownPrompt } from "../../src/core/voiceEngine";
import { voicePlanNotice } from "../../src/core/voiceCast";
import { readingDictionaryFileName } from "../../src/core/readingDictionary";
import { emptyCharacter, type Character } from "../../src/models/character";
import {
  closedEngineUrl,
  describeVoiceRequests,
  FAKE_ACML_TEXT,
  fakeAivmModels,
  startFakeVoiceEngine,
  textCarrying,
  voiceEngineSettings,
  type FakeVoiceEngine,
} from "./support/fakeVoiceEngine";
import { describeNotices, recordedNotices } from "./support/noticeRecord";
import { defaultCharactersFolder, writeCharactersTo } from "./support/settingsFixture";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { chooseEngine, clickAloudButton, dialogButtons, openReadingRow, stopReading, waitDialog } from "./support/voiceReadingUi";
import { holdsFor, waitUntil } from "./support/wait";
import { quickInputWaitContext, quickPickPlaceholder, quickPickRows, quickPickTitle, waitForQuickPick, pressDialogButton, notificationTexts } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const EPISODE_STEM = "001_はじまり";

/** 灯（VOICEVOX の声を割り当てる人物） */
const AKARI: Character = { ...emptyCharacter("char_001", "灯"), appearedChapters: [1] };
/** 語り手に割り当てる声（AivisSpeech の まい／上機嫌） */
const NARRATOR_STYLE_ID = 888753761;
/** 灯に割り当てる声（VOICEVOX の 花音／ささやき） */
const AKARI_STYLE_ID = 1325133121;
/**
 * 灯の平静の台詞で頼む声（花音／ノーマル）。ささやきは感情のスタイルなので、平静の台詞は同じ話者の
 * ノーマルで読む（0.151.1・作者の答え 2026-11-13「スタイルは感情に合わせて自動」）
 */
const AKARI_PLAIN_STYLE_ID = 1325133120;
/** 割り当ての声が引けないときの代わりの声（エンジンの最初の声） */
const FALLBACK_STYLE_ID = 888753760;

const MIX_TEXT = "　朝の駅は静かだった。\n「やった！」と灯は笑った。\n　改札を出ると雨だった。\n";

/** 語り手は AivisSpeech の声、灯は VOICEVOX の声に割り当てた作品を、起こす前に作品フォルダーへ置く */
function prepareMixedWork(episodeText: string) {
  return async ({ workFolder, manuscriptFolder }: { workFolder: string; manuscriptFolder: string }): Promise<void> => {
    expect(episodeText).toContain("「やった！」");
    await writeCharactersTo(defaultCharactersFolder(workFolder), [AKARI]);
    const aiwriter = path.join(workFolder, ".aiwriter");
    await mkdir(path.join(aiwriter, "voiceCast"), { recursive: true });
    const relative = path.relative(workFolder, path.join(manuscriptFolder, EPISODE)).replace(/\\/g, "/");
    // 台詞の話者は作者が決めた形（AI は呼ばない）
    await writeFile(
      path.join(aiwriter, "voiceCast", readingDictionaryFileName(relative)),
      JSON.stringify({
        version: 1,
        episode: relative,
        entries: [{ quote: "「やった！」", nth: 0, speakerId: AKARI.id, speakerName: AKARI.name, emotion: "平静", intensity: "中", source: "author" }],
      }),
      "utf8"
    );
    await writeFile(
      path.join(aiwriter, "voices.json"),
      JSON.stringify({
        version: 1,
        narrator: { speakerUuid: "uuid-mai", speakerName: "まい", styleName: "上機嫌", styleId: NARRATOR_STYLE_ID, engine: "aivisspeech" },
        characters: {
          [AKARI.id]: { speakerUuid: "uuid-kanon", speakerName: "花音", styleName: "ささやき", styleId: AKARI_STYLE_ID, engine: "voicevox", characterName: AKARI.name },
        },
      }),
      "utf8"
    );
  };
}

/** 記録の知らせのうち、`needle` を含むものの数（`since` 以降。時刻の端数の前後に1秒の余裕を見る） */
async function noticeCount(session: E2ESession, needle: string, since: number): Promise<number> {
  return (await recordedNotices(session)).filter((entry) => Date.parse(entry.at) >= since - 1_000 && entry.message.includes(needle)).length;
}

async function waitNoticeRecorded(session: E2ESession, needle: string, since: number, label: string): Promise<void> {
  await waitUntil(async () => (await noticeCount(session, needle, since)) >= 1, label, 40_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeNotices(session, since)}）`);
  });
}

test("両方のエンジンが動いているとき、灯の台詞の頼みだけが VOICEVOX 役へ、ほかは AivisSpeech 役へ届く（エンジンが替わる所の間は記録だけ）", async () => {
  const aivis = await startFakeVoiceEngine({ brand: "AivisSpeech", wavMs: 300 });
  const voicevox = await startFakeVoiceEngine({ brand: "VOICEVOX", wavMs: 300 });
  try {
    await withVsCode(
      "エンジンを混ぜて読む",
      [{ name: EPISODE, text: MIX_TEXT }],
      async (session) => {
        const frame = await openReadingRow(session, EPISODE, "朝の駅は静かだった");
        await chooseEngine(frame, "aivisspeech");
        const startedAt = Date.now();
        await frame.locator("#aloudPlay").click();
        // 灯の台詞が VOICEVOX 役へ、最後の文が AivisSpeech 役へ届くまで（先読みで文は全部頼まれる）
        await waitUntil(
          async () =>
            textCarrying(voicevox).some((request) => request.path === "/synthesis" && request.text.includes("やった")) &&
            textCarrying(aivis).some((request) => request.path === "/synthesis" && request.text.includes("改札を出ると")),
          "灯の台詞が VOICEVOX 役へ、地の文が AivisSpeech 役へ届く",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（VOICEVOX：${describeVoiceRequests(voicevox)}／AivisSpeech：${describeVoiceRequests(aivis)}）`);
        });
        await stopReading(frame);

        const toVoicevox = textCarrying(voicevox);
        const toAivis = textCarrying(aivis);
        // 本文を運ぶ頼みは、灯の台詞だけが VOICEVOX 役へ。平静の台詞なので、割り当てた花音の話者のノーマル
        expect(toVoicevox.every((request) => request.text.includes("やった")), `VOICEVOX 役への頼み：${describeVoiceRequests(voicevox)}`).toBe(true);
        expect(toVoicevox.every((request) => request.speaker === String(AKARI_PLAIN_STYLE_ID)), `VOICEVOX 役への頼み：${describeVoiceRequests(voicevox)}`).toBe(true);
        // ほかの文は AivisSpeech 役へ。灯の台詞は届かず、声の番号は割り当てたまい／上機嫌
        expect(toAivis.some((request) => request.text.includes("朝の駅は静かだった")), `AivisSpeech 役への頼み：${describeVoiceRequests(aivis)}`).toBe(true);
        expect(toAivis.some((request) => request.text.includes("やった")), `AivisSpeech 役へ灯の台詞が届きました：${describeVoiceRequests(aivis)}`).toBe(false);
        expect(toAivis.every((request) => request.speaker === String(NARRATOR_STYLE_ID)), `AivisSpeech 役への頼み：${describeVoiceRequests(aivis)}`).toBe(true);

        // エンジンが替わる所の間の長さ（記録だけ。良し悪しは見ない。鳴り始めの時刻は画面から取れないので、頼みの時刻を残す）
        const synthesisLog = [
          ...toAivis.filter((request) => request.path === "/synthesis").map((request) => ({ engine: "AivisSpeech", at: request.at - startedAt, head: request.text.slice(0, 8) })),
          ...toVoicevox.filter((request) => request.path === "/synthesis").map((request) => ({ engine: "VOICEVOX", at: request.at - startedAt, head: request.text.slice(0, 8) })),
        ].sort((a, b) => a.at - b.at);
        console.info(`voiceEngineMix：合成を頼んだ時刻（ミリ秒。読み始めから）${JSON.stringify(synthesisLog)}`);
      },
      { settings: voiceEngineSettings({ aivisspeech: aivis.url, voicevox: voicevox.url }), prepareWork: prepareMixedWork(MIX_TEXT) }
    );
  } finally {
    await aivis.close();
    await voicevox.close();
  }
}, 240_000);

/** 書き出しの置き場の中身（フォルダーからの相対の道 → 中身。MP3 は頭の2バイトと長さ） */
async function exportedFiles(session: E2ESession): Promise<Map<string, string>> {
  const folder = path.join(session.workFolder, ".aiwriter", "exports", "音声", EPISODE_STEM);
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      // 書き込み途中の一時ファイルは拾わない
      else if (!entry.name.endsWith(".tmp")) {
        const bytes = await readFile(full).catch(() => undefined);
        if (!bytes) continue;
        const key = path.relative(folder, full).replace(/\\/g, "/");
        out.set(key, entry.name.endsWith(".mp3") ? `mp3:${bytes[0]}:${bytes[1]}:${bytes.length}` : bytes.toString("utf8"));
      }
    }
  };
  await walk(folder);
  return out;
}

/** 合成の頼み（`/synthesis`）の本文の `outputSamplingRate` を全部 */
function synthesisRates(engine: FakeVoiceEngine): unknown[] {
  return engine.requests.filter((request) => request.path === "/synthesis").map((request) => (request.body as { outputSamplingRate?: unknown } | undefined)?.outputSamplingRate);
}

test("混ぜた割り当てで［音声に書き出す］→［書き出す］と、両方の偽への合成の頼みの標本化の速さが 44100 で、MP3 ができ、「クレジットと利用条件.txt」に両方の声と「VOICEVOX:花音」が並ぶ", async () => {
  const aivis = await startFakeVoiceEngine({
    brand: "AivisSpeech",
    terms: { aivmModels: fakeAivmModels({ mai: FAKE_ACML_TEXT, kanon: FAKE_ACML_TEXT }), policies: { "uuid-mai": "まいの話者の規約", "uuid-kanon": "花音の話者の規約" } },
  });
  const voicevox = await startFakeVoiceEngine({ brand: "VOICEVOX", terms: { policies: { "uuid-mai": "まいの利用規約（VOICEVOX）", "uuid-kanon": "花音の利用規約（VOICEVOX）" } } });
  try {
    await withVsCode(
      "エンジンを混ぜて書き出す",
      [{ name: EPISODE, text: MIX_TEXT }],
      async (session) => {
        const { page } = session;
        const frame = await openReadingRow(session, EPISODE, "朝の駅は静かだった");
        await chooseEngine(frame, "aivisspeech");
        await clickAloudButton(frame, "aloudVoiceExport");
        let confirm = "";
        await waitUntil(
          async () => {
            const rows = (await quickPickRows(page)).map((row) => row.label);
            confirm = [(await quickPickTitle(page)) ?? "", ...rows].join("\n");
            return confirm.includes("を人物の声で音声（MP3）に書き出します");
          },
          "［音声に書き出す］で書き出しの確認の窓が出る",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（いまの窓：${JSON.stringify(confirm)}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
        });
        // 使う声の欄に、両方のエンジンの声が並ぶ
        expect(confirm, `確認の窓：${confirm}`).toContain("まい");
        expect(confirm, `確認の窓：${confirm}`).toContain("花音");
        expect(textCarrying(aivis).filter((request) => request.path === "/synthesis"), "確認の前に合成しました").toHaveLength(0);
        expect(textCarrying(voicevox).filter((request) => request.path === "/synthesis"), "確認の前に合成しました").toHaveLength(0);
        const rows = await quickPickRows(page);
        const index = rows.findIndex((row) => row.label === "書き出す");
        expect(index, `確認の窓の行：${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(0);
        const since = Date.now();
        await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").nth(index).click();

        const aivisLicense = "ライセンス/まいモデル.txt";
        const voicevoxLicense = "ライセンス/花音.txt";
        let files = new Map<string, string>();
        await waitUntil(
          async () => {
            files = await exportedFiles(session);
            return [`${EPISODE_STEM}.mp3`, "クレジットと利用条件.txt", aivisLicense, voicevoxLicense].every((key) => files.has(key));
          },
          "書き出しの置き場に MP3・注意書き・両方のエンジンのライセンスの全文がそろう",
          60_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（いまある：${JSON.stringify([...files.keys()])}／VOICEVOX：${describeVoiceRequests(voicevox)}／AivisSpeech：${describeVoiceRequests(aivis)}／${await describeNotices(session, since)}）`);
        });

        // 合成の頼みの中身：両方のエンジンへ、標本化の速さ 44100 で頼んでいる（混ぜるときだけ。揃えないと高く速く聞こえる）
        const aivisRates = synthesisRates(aivis);
        const voicevoxRates = synthesisRates(voicevox);
        expect(aivisRates.length, `AivisSpeech 役への合成：${describeVoiceRequests(aivis)}`).toBeGreaterThan(0);
        expect(voicevoxRates.length, `VOICEVOX 役への合成：${describeVoiceRequests(voicevox)}`).toBeGreaterThan(0);
        expect(aivisRates.every((rate) => rate === 44100), `AivisSpeech 役への合成の標本化の速さ：${JSON.stringify(aivisRates)}`).toBe(true);
        expect(voicevoxRates.every((rate) => rate === 44100), `VOICEVOX 役への合成の標本化の速さ：${JSON.stringify(voicevoxRates)}`).toBe(true);
        // 灯の台詞だけが VOICEVOX 役へ（書き出しでも割り当てどおりに分かれる）
        expect(textCarrying(voicevox).every((request) => request.text.includes("やった")), `VOICEVOX 役への頼み：${describeVoiceRequests(voicevox)}`).toBe(true);

        // MP3 のフレームの頭（0xFF・上3ビット）
        const mp3 = files.get(`${EPISODE_STEM}.mp3`) ?? "";
        const [, first, second] = mp3.split(":").map(Number);
        expect(first, `MP3 の頭：${mp3}`).toBe(0xff);
        expect(second & 0xe0, `MP3 の頭：${mp3}`).toBe(0xe0);

        // 注意書きに両方のエンジンの声が並ぶ
        const credits = files.get("クレジットと利用条件.txt") ?? "";
        expect(credits).toContain("※非公式です。話者本人・制作者とは関係ありません。");
        expect(credits).toContain("まいモデル");
        expect(credits).toContain("Aivis Common Model License (ACML) 1.0");
        expect(credits).toContain("VOICEVOX:花音");
        expect(credits).toContain(aivisLicense);
        expect(credits).toContain(voicevoxLicense);
        expect(files.get(aivisLicense)).toContain("まいの話者の規約");
        expect(files.get(voicevoxLicense)).toContain("花音の利用規約（VOICEVOX）");
        // 本文は書き換えない
        expect((await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(MIX_TEXT);
      },
      { settings: voiceEngineSettings({ aivisspeech: aivis.url, voicevox: voicevox.url }), prepareWork: prepareMixedWork(MIX_TEXT) }
    );
  } finally {
    await aivis.close();
    await voicevox.close();
  }
}, 240_000);

test("VOICEVOX を読んでいる途中に止めると、真ん中の窓の2つの文が出て、［AivisSpeech で読む］で灯の台詞も代わりの声で読み続け、一言は1回だけ", async () => {
  // 語り手（AivisSpeech の声）は1文1.5秒。灯の台詞は8番目の文なので、先読みが届くのは4文目を鳴らすころ
  // （先読みは3文先まで）。それまでの数秒のうちに VOICEVOX 役を閉じる
  const aivis = await startFakeVoiceEngine({ brand: "AivisSpeech", wavMs: 1_500 });
  const voicevox = await startFakeVoiceEngine({ brand: "VOICEVOX", wavMs: 500 });
  // 回数は漢数字で書く（半角数字は組んで書く面で縦中横の印に包まれ、字の節点が分かれて探せない）
  const text =
    [...Array.from({ length: 7 }, (_, i) => `　雨は${"一二三四五六七"[i]}度目の角を曲がった。`), "「やった！」と灯は笑った。", "　最後の角で雨は止んだ。", "　傘をたたんだ。"].join("\n") + "\n";
  const down = voiceEngineDownPrompt("read", "voicevox", { engine: "aivisspeech", host: aivis.host });
  const notice = voicePlanNotice({ missing: [], down: [{ engine: "voicevox", slots: ["灯"] }] }, new Map([["voicevox", "unreachable"]]));
  if (!notice) throw new Error("一言の文が作れません");
  const needle = `${VOICE_ENGINE_LABEL.voicevox} に繋がらないので、灯 の声は代わりの声`;
  try {
    await withVsCode(
      "読んでいる途中にエンジンを止める",
      [{ name: EPISODE, text }],
      async (session) => {
        const frame = await openReadingRow(session, EPISODE, "度目の角を曲がった");
        await chooseEngine(frame, "voicevox");
        await frame.locator("#aloudPlay").click();
        await waitUntil(async () => textCarrying(aivis).some((request) => request.path === "/synthesis"), "語り手の最初の文が AivisSpeech 役で作られる（読み始めた）", 30_000).catch(
          (error: unknown) => {
            throw new Error(`${String(error)}（AivisSpeech：${describeVoiceRequests(aivis)}／VOICEVOX：${describeVoiceRequests(voicevox)}）`);
          }
        );
        // 灯の台詞はまだ頼まれていない（読んでいる途中で止める）
        expect(textCarrying(voicevox), `止める前に灯の台詞が頼まれました：${describeVoiceRequests(voicevox)}`).toHaveLength(0);
        const since = Date.now();
        await voicevox.close();

        const shown = await waitDialog(session, frame, down.message, "真ん中の窓に「音声合成のエンジン（VOICEVOX）に繋がりませんでした。」が出る");
        const flat = shown.replace(/\s+/g, "");
        expect(flat, `窓：${shown}`).toContain(`AivisSpeech（${aivis.host}）が動いています。こちらで読みますか。`.replace(/\s+/g, ""));
        expect([...(await dialogButtons(session.page))].sort(), `窓：${shown}`).toEqual(["AivisSpeech で読む", "OSの声で読む"].sort());

        const beforeSwitch = aivis.requests.length;
        await pressDialogButton(session.page, "AivisSpeech で読む");
        await waitUntil(async () => (await frame.locator("#aloudEngine").inputValue()) === "aivisspeech", "［声］が「人物の声（AivisSpeech）」に変わる", 10_000);
        // 灯の台詞も AivisSpeech 役へ、割り当てた声でなく代わりの声（エンジンの最初の声）で頼まれる
        await waitUntil(async () => textCarrying(aivis, beforeSwitch).some((request) => request.path === "/audio_query" && request.text.includes("やった")), "灯の台詞が AivisSpeech 役へ頼まれる", 30_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（AivisSpeech：${describeVoiceRequests(aivis, beforeSwitch)}／列の注：${JSON.stringify(await frame.locator("#aloudNote").innerText().catch(() => ""))}）`);
          }
        );
        const akariLine = textCarrying(aivis, beforeSwitch).find((request) => request.path === "/audio_query" && request.text.includes("やった"));
        expect(akariLine?.speaker, `灯の台詞の声：${describeVoiceRequests(aivis, beforeSwitch)}`).toBe(String(FALLBACK_STYLE_ID));
        // 読み続けている（止まっていない）
        expect((await frame.locator("#aloudPlay").innerText()).includes("読む"), "［AivisSpeech で読む］のあと、読むのが止まっています").toBe(false);

        // 右下の一言「VOICEVOX に繋がらないので、灯 の声は代わりの声…」が、1回だけ
        await waitNoticeRecorded(session, needle, since, "右下に「VOICEVOX に繋がらないので、灯 の声は代わりの声…」が出る");
        const recorded = (await recordedNotices(session)).filter((entry) => entry.message.includes(needle));
        expect(recorded[0]?.message, "一言の文").toBe(notice);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        await holdsFor(async () => (await noticeCount(session, needle, since)) === 1, "一言は1回のまま", 4_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（${await describeNotices(session, since)}）`);
        });
        await stopReading(frame);
      },
      { settings: voiceEngineSettings({ aivisspeech: aivis.url, voicevox: voicevox.url }), prepareWork: prepareMixedWork(text) }
    );
  } finally {
    await aivis.close();
    await voicevox.close();
  }
}, 240_000);

test("AivisSpeech だけが動いているとき、［声の割り当て］の選ぶ窓の入力欄の薄い字に「VOICEVOX に繋がらないので、VOICEVOX の声は並んでいません…」が出る", async () => {
  const aivis = await startFakeVoiceEngine({ brand: "AivisSpeech" });
  const voicevoxClosed = await closedEngineUrl();
  try {
    await withVsCode(
      "声の割り当ての薄い字",
      [{ name: EPISODE, text: MIX_TEXT }],
      async (session) => {
        const { page } = session;
        const frame = await openReadingRow(session, EPISODE, "朝の駅は静かだった");
        await chooseEngine(frame, "aivisspeech");
        await clickAloudButton(frame, "aloudVoiceAssign");
        // 届いた側（AivisSpeech）の声だけから選べる題
        await waitForQuickPick(page, `声の割り当て（この作品の声。選ぶと ${VOICE_ENGINE_LABEL.aivisspeech} の声から選べます）`, 20_000);
        const expected = `${VOICE_ENGINE_LABEL.voicevox} に繋がらないので、${VOICE_ENGINE_LABEL.voicevox} の声は並んでいません（${VOICE_ENGINE_LABEL.voicevox} を起動してから開き直すと並びます）。`;
        let placeholder: string | undefined;
        await waitUntil(async () => (placeholder = await quickPickPlaceholder(page)) === expected, "入力欄の薄い字に「VOICEVOX に繋がらないので…」が出る", 10_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（いまの薄い字：${JSON.stringify(placeholder)}）${await quickInputWaitContext(page)}`);
          }
        );
        await page.keyboard.press("Escape");
      },
      { settings: voiceEngineSettings({ aivisspeech: aivis.url, voicevox: voicevoxClosed }) }
    );
  } finally {
    await aivis.close();
  }
}, 240_000);
