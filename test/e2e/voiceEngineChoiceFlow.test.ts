/**
 * 読み上げの［声］でエンジン（AivisSpeech・VOICEVOX）を選び分ける・届かないときの窓・遅さの知らせ・音声の書き出し
 * （画面の自動テスト、設計書6.42.3・6.42.4・6.113。0.146.0 の実機確認リストの6件と、0.143.0 の書き出しの2件、
 * 「未定の版 人物の声で朗読」の［声の割り当て］の項目の後半〔エンジンを閉じたときの真ん中の窓と［OSの声で読む］〕
 * のうち、押して起きることを機械へ移した。2026-11-09 作者の言葉「実機確認テストが劇的に減っていることを期待します」）。
 *
 * 見張ること（件ごと）：
 * 1. ［声］に「OSの声」「人物の声（AivisSpeech）」「人物の声（VOICEVOX）」の3つが並び、前の版で「人物の声」
 *    （端末の覚えが true）を選んでいたら、古い設定 `novelai.readAloud.voiceEngineUrl` が 50021 なら VOICEVOX、
 *    そうでなければ AivisSpeech が選ばれて開く（決め方そのものは unit/features/voiceEngineSettings・unit/core/voiceEngineChoice）
 * 2. ［声］で VOICEVOX を選んで［▶ 読む］と、本文は VOICEVOX の接続先だけへ届く。［声の割り当て］の一覧の題と
 *    声の一覧の題に「VOICEVOX」が入り、選んだ声が `.aiwriter/voices.json` に VOICEVOX の印つきで残り、次に読むと
 *    その声の番号で頼む
 * 3. VOICEVOX で選んだ声の人物がいる作品を AivisSpeech で読むと、その人物の台詞は代わりの声の番号で AivisSpeech へ
 *    頼まれ、右下の一言「割り当てた声のうち 灯 の声が AivisSpeech に見つからないので…」が**1回だけ**出る
 *    （読んでいる途中に打っても出し直さない）。［声の割り当て］の一覧で、その人物に「（VOICEVOXの声）」が添えてある
 * 4. VOICEVOX が閉じていて AivisSpeech が動いているとき、［▶ 読む］で真ん中の窓に「…（VOICEVOX）に繋がりませんでした。」
 *    「AivisSpeech（127.0.0.1:<口>）が動いています。こちらで読みますか。」が出て、［AivisSpeech で読む］で［声］が
 *    AivisSpeech に変わり、本文が AivisSpeech へ届く。両方とも閉じているときは［OSの声で読む］だけで、押すと
 *    ［声］が OS の声になって読み始める（OS の声は偽物に替える。readAloudMark と同じ手）
 * 5. 声づくりが読む速さに追いつかない偽のエンジン（0.2秒の音を1文0.7秒で、1つずつ順に返す）で読むと、
 *    「この PC では、AivisSpeech の声づくりが読む速さに追いついていません…」が1回の読み上げで1回だけ出る
 *    （条件そのものは unit/core/voicePace・unit/features/voiceEngineFallback）
 * 6. 列の［音声に書き出す］で書き出しの確認の窓（上の選ぶ窓）が出て（0.143.0〜0.145.0 はこのボタンで何も起きなかった）、
 *    ［書き出す］で作品の `.aiwriter/exports/音声/<話>/` に MP3 と「クレジットと利用条件.txt」と「ライセンス/」が
 *    本物のディスクにでき、MP3 の変換は配る束の `dist/lame.js` を通る（単体テストは npm の部品を直接使うので、
 *    ここだけが配る形の道を通す）。AivisSpeech と VOICEVOX の両方で
 *
 * **本物のエンジンは起こさない。** 偽のエンジン（`support/fakeVoiceEngine.ts`）を 127.0.0.1 に立て、接続先は使い捨ての
 * ユーザー設定へ向ける。閉じたエンジンは、いったん待ち受けて閉じた口（製品の既定の 10101・50021 は、流す機械で本物が
 * 動いていると繋がってしまうので使わない）。**AI は呼ばない。**
 *
 * **作者の手に残すもの**：声が自然か・読み分けて聞こえるか・感情のスタイル・MP3 を耳で聞くこと・本物のエンジン
 * （AivisSpeech・VOICEVOX）とノートPCで実際に遅さの知らせが出るか（速い PC で出ないか）・窓が目に留まるか。
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { VOICE_ENGINE_LABEL, voiceEngineDownPrompt, type VoiceEngineId } from "../../src/core/voiceEngine";
import { unresolvedVoiceNotice } from "../../src/core/voiceCast";
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
} from "./support/fakeVoiceEngine";
import { clickToolButton, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { describeNotices, recordedNotices } from "./support/noticeRecord";
import { defaultCharactersFolder, writeCharactersTo } from "./support/settingsFixture";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { dialogText, notificationTexts, pressDialogButton, quickInputWaitContext, quickPickRows, quickPickTitle, waitForQuickPick } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const EPISODE_STEM = "001_はじまり";
const SHORT_TEXT = "　朝の駅は静かだった。\n「おはよう」と彼女が言った。\n";
/** 端末の覚え（globalState）の鍵。0.146.0 からはエンジンの名前、OSの声は false、前の版の「人物の声」は true */
const READ_ALOUD_ENGINE_KEY = "novelai.readAloud.engine";

/** 灯（VOICEVOX で選んだ声を持つ人物） */
const AKARI: Character = { ...emptyCharacter("char_001", "灯"), appearedChapters: [1] };

/** 面の中の OS の声を偽物に替える（読む文を `__e2eSpoken` へ控える。音は出ない。readAloudMark と同じ形） */
async function installFakeOsVoice(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const spoken: string[] = [];
    (window as unknown as { __e2eSpoken: string[] }).__e2eSpoken = spoken;
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
      getVoices: () => [{ name: "E2E 日本語", lang: "ja-JP" }],
      speak: (utterance: FakeUtterance) => {
        spoken.push(utterance.text);
      },
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      addEventListener: () => undefined,
    };
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true, writable: true });
    Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
  });
}

async function osSpoken(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => (window as unknown as { __e2eSpoken?: string[] }).__e2eSpoken ?? []);
}

async function aloudNote(frame: Frame): Promise<string> {
  return frame.locator("#aloudNote").innerText().catch(() => "");
}

/** 話を開き、偽の OS の声を入れ、読み上げの列を出して、人物の声が選べる（拡張機能が使えると知らせた）まで待つ */
async function openReadingRow(session: E2ESession, marker: string): Promise<Frame> {
  const frame = await openEpisode(session.page, EPISODE, marker);
  await installFakeOsVoice(frame);
  await clickToolButton(frame, "aloudToggle");
  await waitUntil(
    async () => (await frame.locator('#aloudEngine option[value="aivisspeech"]').isDisabled().catch(() => true)) === false,
    "［声］で人物の声が選べる",
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列の注：${JSON.stringify(await aloudNote(frame))}）`);
  });
  return frame;
}

/**
 * 読み上げの列のボタンを押す。**列（`#aloud`）は上の段（`.tray`）の外にある**ので `clickToolButton` は使えない
 * （段を探して見つからずに投げる）。［▶ 読む］と同じく直接押す。人物の声の操作は人物の声を選んだときだけ出る
 */
async function clickAloudButton(frame: Frame, id: "aloudVoiceAssign" | "aloudVoiceExport"): Promise<void> {
  await waitUntil(async () => frame.locator(`#${id}`).isVisible().catch(() => false), `読み上げの列に #${id} が出る`, 10_000);
  await frame.locator(`#${id}`).click();
}

/** ［声］をそのエンジンにして、［▶ 読む］が押せるまで待つ */
async function chooseEngine(frame: Frame, choice: "os" | VoiceEngineId): Promise<void> {
  if ((await frame.locator("#aloudEngine").inputValue()) !== choice) await frame.locator("#aloudEngine").selectOption(choice);
  await waitUntil(async () => !(await frame.locator("#aloudPlay").isDisabled()), "［▶ 読む］が押せる", 20_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列の注：${JSON.stringify(await aloudNote(frame))}）`);
  });
}

/** 読んでいれば止めて、［▶ 読む］に戻るまで待つ */
async function stopReading(frame: Frame): Promise<void> {
  if (!(await frame.locator("#aloudStop").isDisabled().catch(() => true))) await frame.locator("#aloudStop").click();
  await waitUntil(async () => (await frame.locator("#aloudPlay").innerText()).includes("読む"), "［▶ 読む］に戻る", 15_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（ボタン：${JSON.stringify(await frame.locator("#aloudPlay").innerText().catch(() => ""))}）`);
  });
}

/** 真ん中の窓（モーダル）の製品のボタン。VS Code が足す［キャンセル］は除く */
async function dialogButtons(page: Page): Promise<string[]> {
  return (await page.locator(".monaco-dialog-box .monaco-button").allInnerTexts())
    .map((text) => text.trim())
    .filter((text) => text !== "" && text !== "Cancel" && text !== "キャンセル");
}

/** 真ん中の窓が `needle` を含んで出るまで待ち、窓の文を返す */
async function waitDialog(session: E2ESession, frame: Frame, needle: string, label: string): Promise<string> {
  let text = "";
  await waitUntil(async () => (text = (await dialogText(session.page)) ?? "").includes(needle), label, 30_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（窓：${JSON.stringify(text)}／列の注：${JSON.stringify(await aloudNote(frame))}／${await describeNotices(session)}）`);
  });
  return text;
}

/** 記録の知らせのうち、`needle` を含むものの数（`since` 以降。時刻の端数の前後に1秒の余裕を見る） */
async function noticeCount(session: E2ESession, needle: string, since: number): Promise<number> {
  return (await recordedNotices(session)).filter((entry) => Date.parse(entry.at) >= since - 1_000 && entry.message.includes(needle)).length;
}

/** 知らせが記録に1つ載るまで待つ（右下に出ていれば、記録が書かれる1秒のまとめを待つ） */
async function waitNoticeRecorded(session: E2ESession, needle: string, since: number, label: string): Promise<void> {
  await waitUntil(async () => (await noticeCount(session, needle, since)) >= 1, label, 40_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeNotices(session, since)}）`);
  });
}

/** `.aiwriter/voices.json`（無ければ undefined） */
async function readVoices(session: E2ESession): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(path.join(session.workFolder, ".aiwriter", "voices.json"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 書き換えの途中（退避→作り直し）で読んだ。次の回で読めればよい
    return undefined;
  }
}

test("［声］に3つのエンジンが並び、前の版で「人物の声」を選んでいた人は、古い接続先の設定が指している側で開く", async () => {
  const cases: Array<{ label: string; settings: Record<string, unknown>; stored: unknown; expected: string }> = [
    { label: "古い設定が 50021（VOICEVOX）", settings: { "novelai.readAloud.voiceEngineUrl": "http://127.0.0.1:50021" }, stored: true, expected: "voicevox" },
    { label: "古い設定を書いていない", settings: {}, stored: true, expected: "aivisspeech" },
    { label: "前の版で OS の声", settings: {}, stored: false, expected: "os" },
  ];
  for (const testCase of cases) {
    await withVsCode(
      `［声］の3択（${testCase.label}）`,
      [{ name: EPISODE, text: SHORT_TEXT }],
      async (session) => {
        const frame = await openReadingRow(session, "朝の駅は静かだった");
        const options = await frame.locator("#aloudEngine option").evaluateAll((elements) =>
          elements.map((element) => ({ value: (element as HTMLOptionElement).value, text: (element.textContent ?? "").trim() }))
        );
        expect(options.map((option) => option.value), `［声］の選択肢：${JSON.stringify(options)}`).toEqual(["os", "aivisspeech", "voicevox"]);
        expect(options[0].text).toBe("OSの声");
        expect(options[1].text.startsWith("人物の声（AivisSpeech）"), `選択肢：${JSON.stringify(options)}`).toBe(true);
        expect(options[2].text.startsWith("人物の声（VOICEVOX）"), `選択肢：${JSON.stringify(options)}`).toBe(true);
        let value = "";
        await waitUntil(async () => (value = await frame.locator("#aloudEngine").inputValue()) === testCase.expected, `${testCase.label}：［声］が ${testCase.expected} で開く`, 15_000).catch(
          (error: unknown) => {
            throw new Error(`${String(error)}（いまの［声］：${value}）`);
          }
        );
        // 少し待っても選び直されない（あとから届く知らせで別の値に戻らない）
        await holdsFor(async () => (await frame.locator("#aloudEngine").inputValue()) === testCase.expected, `${testCase.label}：［声］が ${testCase.expected} のまま`, 2_000);
      },
      { settings: testCase.settings, globalState: { [READ_ALOUD_ENGINE_KEY]: testCase.stored } }
    );
  }
}, 240_000);

test("［声］で VOICEVOX を選ぶと本文は VOICEVOX の接続先へ届き、［声の割り当て］は VOICEVOX の声から選んで印つきで残り、次に読むとその声で頼む", async () => {
  const aivis = await startFakeVoiceEngine({ brand: "AivisSpeech" });
  const voicevox = await startFakeVoiceEngine({ brand: "VOICEVOX" });
  try {
    await withVsCode(
      "VOICEVOX で読む・割り当てる",
      [{ name: EPISODE, text: SHORT_TEXT }],
      async (session) => {
        const { page } = session;
        const frame = await openReadingRow(session, "朝の駅は静かだった");
        await chooseEngine(frame, "voicevox");

        /* ── VOICEVOX で読む ── */
        await frame.locator("#aloudPlay").click();
        await waitUntil(async () => textCarrying(voicevox).some((request) => request.text.includes("朝の駅は静かだった")), "本文が VOICEVOX の接続先へ届く", 20_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（VOICEVOX：${describeVoiceRequests(voicevox)}／AivisSpeech：${describeVoiceRequests(aivis)}／列の注：${JSON.stringify(await aloudNote(frame))}）`);
          }
        );
        expect(textCarrying(aivis), `AivisSpeech へ本文が届きました：${describeVoiceRequests(aivis)}`).toHaveLength(0);
        await stopReading(frame);

        /* ── ［声の割り当て］ ── */
        const listTitle = `声の割り当て（この作品の声。選ぶと ${VOICE_ENGINE_LABEL.voicevox} の声から選べます）`;
        await clickAloudButton(frame, "aloudVoiceAssign");
        const rows = await waitForQuickPick(page, listTitle, 20_000);
        expect(rows.map((row) => row.label), `一覧：${JSON.stringify(rows)}`).toContain("語り手（地の文）");
        await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").nth(rows.findIndex((row) => row.label === "語り手（地の文）")).click();
        const voices = await waitForQuickPick(page, `語り手（地の文）の声（${VOICE_ENGINE_LABEL.voicevox}）`, 20_000);
        const index = voices.findIndex((row) => row.label === "まい／上機嫌");
        expect(index, `声の一覧：${JSON.stringify(voices)}`).toBeGreaterThanOrEqual(0);
        await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").nth(index).click();
        // 選ぶと一覧へ戻り、語り手の欄に選んだ声が出る
        await waitUntil(
          async () => (await quickPickTitle(page)) === listTitle && (await quickPickRows(page)).some((row) => row.label === "語り手（地の文）" && row.description.includes("まい／上機嫌")),
          "一覧へ戻り、語り手の欄に「まい／上機嫌」が出る",
          20_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
        });
        let saved: Record<string, unknown> | undefined;
        await waitUntil(async () => (saved = await readVoices(session)) !== undefined, "voices.json ができる", 15_000);
        expect(saved?.narrator, `voices.json：${JSON.stringify(saved)}`).toMatchObject({ speakerUuid: "uuid-mai", styleName: "上機嫌", styleId: 888753761, engine: "voicevox" });
        await page.keyboard.press("Escape");
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "一覧が閉じる", 10_000);

        /* ── 次に読むと、選んだ声の番号で VOICEVOX へ頼む ── */
        const before = voicevox.requests.length;
        await frame.locator("#aloudPlay").click();
        await waitUntil(async () => textCarrying(voicevox, before).some((request) => request.path === "/synthesis" && request.speaker === "888753761"), "選んだ声（888753761）で VOICEVOX へ頼む", 20_000).catch(
          (error: unknown) => {
            throw new Error(`${String(error)}（VOICEVOX：${describeVoiceRequests(voicevox, before)}）`);
          }
        );
        expect(textCarrying(aivis), `AivisSpeech へ本文が届きました：${describeVoiceRequests(aivis)}`).toHaveLength(0);
        await stopReading(frame);
      },
      { settings: voiceEngineSettings({ aivisspeech: aivis.url, voicevox: voicevox.url }) }
    );
  } finally {
    await aivis.close();
    await voicevox.close();
  }
}, 240_000);

test("VOICEVOX で選んだ声の人物がいる作品を AivisSpeech で読むと、その台詞は代わりの声で頼み、一言は1回の読み上げで1回だけ（途中で打っても出し直さない）。［声の割り当て］にはエンジンの名前が添えてある", async () => {
  const aivis = await startFakeVoiceEngine({ brand: "AivisSpeech", wavMs: 1_500 });
  const voicevoxClosed = await closedEngineUrl();
  // 1文1.5秒の音を10文ほど。打つまでのあいだ読み続けているように長めにする。
  // 回数は漢数字で書く——半角数字は組んで書く面で縦中横の印（span.tcy）に包まれ、
  // 「9」と「度目の角」が別の字の節点に分かれて placeCaretAfter が見つけられない（0.148.1 の e2e で落ちた）
  const text = ["「やった！」と灯は笑った。", ...Array.from({ length: 9 }, (_, i) => `　雨は${"一二三四五六七八九"[i]}度目の角を曲がった。`)].join("\n") + "\n";
  const notice = unresolvedVoiceNotice(["灯"], VOICE_ENGINE_LABEL.aivisspeech);
  if (!notice) throw new Error("一言の文が作れません");
  const needle = `割り当てた声のうち 灯 の声が ${VOICE_ENGINE_LABEL.aivisspeech} に見つからないので`;
  try {
    await withVsCode(
      "エンジンを戻したときの代わりの声",
      [{ name: EPISODE, text }],
      async (session) => {
        const { page } = session;
        const frame = await openReadingRow(session, "度目の角を曲がった");
        await chooseEngine(frame, "aivisspeech");
        const since = Date.now();
        await frame.locator("#aloudPlay").click();
        await waitNoticeRecorded(session, needle, since, "右下に「割り当てた声のうち 灯 の声が AivisSpeech に見つからないので…」が出る");
        const recorded = (await recordedNotices(session)).filter((entry) => entry.message.includes(needle));
        expect(recorded[0]?.message, "一言の文").toBe(notice);
        // 灯の台詞は、割り当てた VOICEVOX の声（1325133121）でなく、代わりの声（エンジンの最初の声 888753760）で AivisSpeech へ
        await waitUntil(async () => textCarrying(aivis).some((request) => request.path === "/audio_query" && request.text.includes("やった")), "灯の台詞が AivisSpeech へ頼まれる", 20_000).catch(
          (error: unknown) => {
            throw new Error(`${String(error)}（AivisSpeech：${describeVoiceRequests(aivis)}）`);
          }
        );
        const akariLine = textCarrying(aivis).find((request) => request.path === "/audio_query" && request.text.includes("やった"));
        expect(akariLine?.speaker, `灯の台詞の声：${describeVoiceRequests(aivis)}`).toBe("888753760");

        /* ── 読んでいる途中に打つ（計画を取り直す）。一言は出し直さない ── */
        expect((await frame.locator("#aloudPlay").innerText()).includes("読む"), "打つ前に読み終わっていました（音を長くする）").toBe(false);
        await placeCaretAfter(frame, "九度目の角");
        await page.keyboard.insertText("ぽ");
        // 記録は1秒まとめて書かれる。打ったあとに出たかもしれない分が載るまで待ってから見続ける
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        await holdsFor(async () => (await noticeCount(session, needle, since)) === 1, "途中で打っても一言は1回のまま", 4_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（${await describeNotices(session, since)}）`);
        });
        await stopReading(frame);

        /* ── ［声の割り当て］の一覧に、VOICEVOX の声と添えてある ── */
        await clickAloudButton(frame, "aloudVoiceAssign");
        const rows = await waitForQuickPick(page, `声の割り当て（この作品の声。選ぶと ${VOICE_ENGINE_LABEL.aivisspeech} の声から選べます）`, 20_000);
        const akari = rows.find((row) => row.label === "灯");
        expect(akari?.description, `一覧：${JSON.stringify(rows)}`).toBe(`花音／ささやき（${VOICE_ENGINE_LABEL.voicevox}の声）`);
        await page.keyboard.press("Escape");
      },
      {
        settings: voiceEngineSettings({ aivisspeech: aivis.url, voicevox: voicevoxClosed }),
        prepareWork: async ({ workFolder, manuscriptFolder }) => {
          await writeCharactersTo(defaultCharactersFolder(workFolder), [AKARI]);
          const aiwriter = path.join(workFolder, ".aiwriter");
          await mkdir(path.join(aiwriter, "voiceCast"), { recursive: true });
          const relative = path.relative(workFolder, path.join(manuscriptFolder, EPISODE)).replace(/\\/g, "/");
          // 台詞の話者は作者が決めた形（AI は呼ばない）。声は VOICEVOX で選んだ印つき
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
              characters: {
                [AKARI.id]: { speakerUuid: "uuid-kanon", speakerName: "花音", styleName: "ささやき", styleId: 1325133121, engine: "voicevox", characterName: AKARI.name },
              },
            }),
            "utf8"
          );
        },
      }
    );
  } finally {
    await aivis.close();
  }
}, 240_000);

test("VOICEVOX が閉じていて AivisSpeech が動いていれば、真ん中の窓の［AivisSpeech で読む］で［声］が切り替わって読む。両方閉じていれば［OSの声で読む］だけで、押すと OS の声で読む", async () => {
  const aivis = await startFakeVoiceEngine({ brand: "AivisSpeech" });
  const voicevoxClosed = await closedEngineUrl();
  const aivisClosed = await closedEngineUrl();
  try {
    /* ── もう片方（AivisSpeech）が動いている ── */
    await withVsCode(
      "もう片方のエンジンで読む",
      [{ name: EPISODE, text: SHORT_TEXT }],
      async (session) => {
        const frame = await openReadingRow(session, "朝の駅は静かだった");
        await chooseEngine(frame, "voicevox");
        await frame.locator("#aloudPlay").click();
        const prompt = voiceEngineDownPrompt("read", "voicevox", { engine: "aivisspeech", host: aivis.host });
        const shown = await waitDialog(session, frame, prompt.message, "真ん中の窓に「音声合成のエンジン（VOICEVOX）に繋がりませんでした。」が出る");
        const flat = shown.replace(/\s+/g, "");
        expect(flat, `窓：${shown}`).toContain(`AivisSpeech（${aivis.host}）が動いています。こちらで読みますか。`.replace(/\s+/g, ""));
        expect([...(await dialogButtons(session.page))].sort(), `窓：${shown}`).toEqual(["AivisSpeech で読む", "OSの声で読む"].sort());
        expect(textCarrying(aivis), "窓で答える前に、本文が AivisSpeech へ届きました").toHaveLength(0);
        await pressDialogButton(session.page, "AivisSpeech で読む");
        await waitUntil(async () => (await frame.locator("#aloudEngine").inputValue()) === "aivisspeech", "［声］が「人物の声（AivisSpeech）」に変わる", 10_000);
        await waitUntil(async () => textCarrying(aivis).some((request) => request.text.includes("朝の駅は静かだった")), "本文が AivisSpeech へ届く（いまの場所から読む）", 20_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（AivisSpeech：${describeVoiceRequests(aivis)}／列の注：${JSON.stringify(await aloudNote(frame))}）`);
          }
        );
        await stopReading(frame);
      },
      { settings: voiceEngineSettings({ aivisspeech: aivis.url, voicevox: voicevoxClosed }) }
    );

    /* ── 両方閉じている（今までの窓） ── */
    await withVsCode(
      "両方のエンジンが閉じている",
      [{ name: EPISODE, text: SHORT_TEXT }],
      async (session) => {
        const frame = await openReadingRow(session, "朝の駅は静かだった");
        await chooseEngine(frame, "aivisspeech");
        await frame.locator("#aloudPlay").click();
        const prompt = voiceEngineDownPrompt("read", "aivisspeech");
        const shown = await waitDialog(session, frame, prompt.message, "真ん中の窓に「音声合成のエンジン（AivisSpeech）に繋がりませんでした。」が出る");
        expect(shown.replace(/\s+/g, ""), `窓：${shown}`).toContain("AivisSpeechを起動してから、もう一度［▶読む］を押してください。".replace(/\s+/g, ""));
        expect(await dialogButtons(session.page), `窓：${shown}`).toEqual(["OSの声で読む"]);
        await pressDialogButton(session.page, "OSの声で読む");
        await waitUntil(async () => (await frame.locator("#aloudEngine").inputValue()) === "os", "［声］が「OSの声」に変わる", 10_000);
        await waitUntil(async () => (await osSpoken(frame)).some((spoken) => spoken.includes("朝の駅は静かだった")), "OS の声で読み始める", 15_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（OS の声が受けた文：${JSON.stringify(await osSpoken(frame))}／列の注：${JSON.stringify(await aloudNote(frame))}）`);
        });
        await stopReading(frame);
      },
      { settings: voiceEngineSettings({ aivisspeech: aivisClosed, voicevox: voicevoxClosed }) }
    );
  } finally {
    await aivis.close();
  }
}, 240_000);

test("声づくりが読む速さに追いつかないエンジンで読むと、遅さの知らせが1回の読み上げで1回だけ出る", async () => {
  // 0.2秒の音を、1文0.7秒かけて1つずつ作る（はじめの2文を除き、続けて3文遅ければ知らせる作り）
  const slow = await startFakeVoiceEngine({ brand: "AivisSpeech", wavMs: 200, synthesisDelayMs: 700 });
  const text = Array.from({ length: 10 }, (_, i) => `　灯台の明かりが${i + 1}回まわった。`).join("\n") + "\n";
  const needle = `この PC では、${VOICE_ENGINE_LABEL.aivisspeech} の声づくりが読む速さに追いついていません`;
  try {
    await withVsCode(
      "遅さの知らせ",
      [{ name: EPISODE, text }],
      async (session) => {
        const frame = await openReadingRow(session, "回まわった");
        await chooseEngine(frame, "aivisspeech");
        const since = Date.now();
        await frame.locator("#aloudPlay").click();
        await waitNoticeRecorded(session, needle, since, "右下に「この PC では、AivisSpeech の声づくりが読む速さに追いついていません…」が出る");
        const message = (await recordedNotices(session)).find((entry) => entry.message.includes(needle))?.message ?? "";
        expect(message, "知らせの文").toMatch(/（0\.2秒の音に約\d+秒）。［音声に書き出す］で先に作っておくと、間をあけずに聞けます。$/);
        // 読み終わるまで見続けても、1回のまま
        await holdsFor(async () => (await noticeCount(session, needle, since)) === 1, "同じ読み上げの中で知らせは1回のまま", 5_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（${await describeNotices(session, since)}）`);
        });
        await stopReading(frame);
      },
      { settings: voiceEngineSettings({ aivisspeech: slow.url, voicevox: await closedEngineUrl() }) }
    );
  } finally {
    await slow.close();
  }
}, 240_000);

/** 書き出しの確認の窓（上の選ぶ窓）を待ち、題と行を合わせた字を返す */
async function waitExportConfirm(page: Page): Promise<string> {
  let text = "";
  await waitUntil(
    async () => {
      const rows = (await quickPickRows(page)).map((row) => row.label);
      text = [(await quickPickTitle(page)) ?? "", ...rows].join("\n");
      return text.includes("を人物の声で音声（MP3）に書き出します");
    },
    "［音声に書き出す］で書き出しの確認の窓が出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
  });
  return text;
}

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

for (const engine of ["aivisspeech", "voicevox"] as const) {
  const label = VOICE_ENGINE_LABEL[engine];
  test(`${label}：列の［音声に書き出す］で確認の窓が出て、［書き出す］で MP3 と「クレジットと利用条件.txt」と「ライセンス/」が作品の .aiwriter/exports/音声/ にできる`, async () => {
    const fake = await startFakeVoiceEngine(
      engine === "aivisspeech"
        ? {
            brand: "AivisSpeech",
            terms: { aivmModels: fakeAivmModels({ mai: FAKE_ACML_TEXT, kanon: FAKE_ACML_TEXT }), policies: { "uuid-mai": "まいの話者の規約", "uuid-kanon": "花音の話者の規約" } },
          }
        : { brand: "VOICEVOX", terms: { policies: { "uuid-mai": "まいの利用規約（VOICEVOX）", "uuid-kanon": "花音の利用規約（VOICEVOX）" } } }
    );
    const licenseFile = engine === "aivisspeech" ? "ライセンス/まいモデル.txt" : "ライセンス/まい.txt";
    try {
      await withVsCode(
        `音声に書き出す（${label}）`,
        [{ name: EPISODE, text: SHORT_TEXT }],
        async (session) => {
          const { page } = session;
          const frame = await openReadingRow(session, "朝の駅は静かだった");
          await chooseEngine(frame, engine);
          await clickAloudButton(frame, "aloudVoiceExport");
          const confirm = await waitExportConfirm(page);
          expect(confirm, `確認の窓：${confirm}`).toContain(`置き場：`);
          expect(confirm, `確認の窓：${confirm}`).toContain(`.aiwriter/exports/音声/${EPISODE_STEM}`);
          // 確認で答える前は、本文を合成へ送らない
          expect(textCarrying(fake).filter((request) => request.path === "/synthesis"), "確認の前に合成しました").toHaveLength(0);
          const rows = await quickPickRows(page);
          const index = rows.findIndex((row) => row.label === "書き出す");
          expect(index, `確認の窓の行：${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(0);
          const since = Date.now();
          await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").nth(index).click();

          let files = new Map<string, string>();
          await waitUntil(
            async () => {
              files = await exportedFiles(session);
              return [`${EPISODE_STEM}.mp3`, "クレジットと利用条件.txt", licenseFile].every((key) => files.has(key));
            },
            "書き出しの置き場に MP3・注意書き・ライセンスの全文がそろう",
            60_000
          ).catch(async (error: unknown) => {
            throw new Error(`${String(error)}（いまある：${JSON.stringify([...files.keys()])}／${describeVoiceRequests(fake)}／${await describeNotices(session, since)}）`);
          });
          // MP3 のフレームの頭（0xFF・上3ビット）。配る束の dist/lame.js で変換した
          const mp3 = files.get(`${EPISODE_STEM}.mp3`) ?? "";
          const [, first, second] = mp3.split(":").map(Number);
          expect(first, `MP3 の頭：${mp3}`).toBe(0xff);
          expect(second & 0xe0, `MP3 の頭：${mp3}`).toBe(0xe0);
          const credits = files.get("クレジットと利用条件.txt") ?? "";
          expect(credits).toContain("※非公式です。話者本人・制作者とは関係ありません。");
          expect(credits).toContain(licenseFile);
          if (engine === "aivisspeech") {
            expect(credits).toContain("まいモデル");
            expect(credits).toContain("Aivis Common Model License (ACML) 1.0");
            expect(files.get(licenseFile)).toContain("# Aivis Common Model License (ACML) 1.0");
            expect(files.get(licenseFile)).toContain("まいの話者の規約");
          } else {
            expect(credits).toContain("VOICEVOX:まい");
            expect(files.get(licenseFile)).toContain("まいの利用規約（VOICEVOX）");
          }
          // 知らせに要点と［フォルダーを開く］（記録には文だけが載るので、文の要点を見る）
          await waitNoticeRecorded(session, engine === "aivisspeech" ? "ACML" : "VOICEVOX:まい", since, "書き出しの知らせが出る");
          // 本文は書き換えない
          expect((await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(SHORT_TEXT);
        },
        { settings: voiceEngineSettings(engine === "aivisspeech" ? { aivisspeech: fake.url, voicevox: await closedEngineUrl() } : { aivisspeech: await closedEngineUrl(), voicevox: fake.url }) }
      );
    } finally {
      await fake.close();
    }
  }, 240_000);
}
