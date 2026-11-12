/**
 * 本物の音声エンジン（AivisSpeech・VOICEVOX）へ向けた画面の自動テスト（`*.real.ts`）の共通の部品。
 *
 * 名前を `realSupport.ts`（`.real.ts` でない）にしてあるので、専用の設定 `vitest.real.config.mts` の
 * `include`（`*.real.ts`）には拾われない。本物のエンジンを使うのは、これを読み込む `*.real.ts` の試験だけ。
 *
 * ## 門（環境変数）
 * - `NOVELAI_REAL_AIVIS=1` … 本物の AivisSpeech（127.0.0.1:10101）を使う件
 * - `NOVELAI_REAL_VOICEVOX=1` … 本物の VOICEVOX（127.0.0.1:50021）を使う件
 * - 両方 … 2つを混ぜる件
 * - `NOVELAI_REAL_FAST_PC=1` … 速い PC（作者の Windows）でだけ見る件（遅さの知らせが出ないこと）。
 *   遅い機械（CPU の AivisSpeech）で付けると、遅さの知らせが出て落ちる
 *
 * ## 置き場
 * `NOVELAI_REAL_OUT` の下に **版と日付のフォルダー**（`v0.151.0_20261112`）を作り、MP3・注意書き・
 * `聞くところ.md` を置く。作者へはセッションがこのフォルダーのファイルを送る（作者は聞いて答えるだけ）。
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { readingDictionaryFileName } from "../../../src/core/readingDictionary";
import { castDialogues, type CastEntry } from "../../../src/core/voiceCast";
import { parseSpeakers, type VoiceEngineId, type VoiceSpeaker } from "../../../src/core/voiceEngine";
import { characterFileName, emptyCharacter, type Character } from "../../../src/models/character";
import { clickToolButton, openEpisode } from "../support/manuscriptFrame";
import { recordedNotices } from "../support/noticeRecord";
import { type E2ESession, type FixtureEpisode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { dialogText, notificationTexts, quickInputWaitContext, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { defaultCharactersFolder } from "../support/settingsFixture";

export const GATE_AIVIS = process.env.NOVELAI_REAL_AIVIS === "1";
export const GATE_VOICEVOX = process.env.NOVELAI_REAL_VOICEVOX === "1";
export const GATE_MIX = GATE_AIVIS && GATE_VOICEVOX;
export const GATE_FAST_PC = GATE_AIVIS && process.env.NOVELAI_REAL_FAST_PC === "1";

export const REAL_URL: Record<VoiceEngineId, string> = {
  aivisspeech: "http://127.0.0.1:10101",
  voicevox: "http://127.0.0.1:50021",
};
/** 使わないエンジンの接続先（9番の口は誰も待ち受けない。本物が動いていても繋がらない） */
export const DEAD_URL = "http://127.0.0.1:9";

export const SLOW_NOTICE = "この PC では、AivisSpeech の声づくりが読む速さに追いついていません";

const OUT_ROOT = process.env.NOVELAI_REAL_OUT ?? path.join(process.env.TEMP ?? ".", "novelai-real-aivis");

/* ── 置き場と「聞くところ」 ── */

let outDirCache: string | undefined;

/** 版と日付のフォルダー（無ければ作る）。版は package.json、日付はこの機械の今日 */
export async function outDir(): Promise<string> {
  if (outDirCache) return outDirCache;
  const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  outDirCache = path.join(OUT_ROOT, `v${pkg.version ?? "unknown"}_${stamp}`);
  await mkdir(outDirCache, { recursive: true });
  return outDirCache;
}

/**
 * `聞くところ.md` に1行足す（同じファイルの行があれば置き換える）。
 * `file` は置き場からの相対の道、`item` は実機確認リストの行（例「26・28行」）、`what` はどこを聞くか。
 * 件ごとに別々の走りで流しても、前の行を消さない
 */
export async function noteListening(file: string, item: string, what: string): Promise<void> {
  const dir = await outDir();
  const target = path.join(dir, "聞くところ.md");
  const existing = await readFile(target, "utf8").catch(() => "");
  const lines = existing.split("\n").filter((line) => line.startsWith("- "));
  const key = `- ${file}（`;
  const kept = lines.filter((line) => !line.startsWith(key));
  kept.push(`- ${file}（実機確認リスト ${item}）：${what}`);
  kept.sort();
  const header = [
    `# 聞くところ（${path.basename(dir)}）`,
    "",
    "ファイルごとに、どの項目の何を聞くか。聞いて、合っているか・おかしいかだけ答えてください。",
    "",
  ];
  await writeFile(target, `${[...header, ...kept].join("\n")}\n`, "utf8");
}

/** フォルダーの中身（相対の道）を、置き場の `dest` へ写す。写した相対の道を返す */
export async function copyTree(from: string, dest: string): Promise<string[]> {
  const files = await readdir(from, { recursive: true }).then((list) => list.map(String)).catch(() => []);
  const copied: string[] = [];
  for (const file of files) {
    const source = path.join(from, file);
    const target = path.join(dest, file);
    await mkdir(path.dirname(target), { recursive: true });
    // フォルダーを写そうとすると失敗する。それは飛ばす（中の文書は別の行で写る）
    if (await copyFile(source, target).then(() => true, () => false)) copied.push(file);
  }
  return copied;
}

/* ── MP3 ── */

/**
 * MP3 の最初のフレームの標本化の速さ（Hz）。ID3 の頭があれば飛ばす。読めなければ undefined。
 * 2つのエンジンの音を 44100Hz に揃えて作らせている（0.151.0）ので、混ぜた声の MP3 は 44100 のはず
 */
export function mp3SampleRate(bytes: Uint8Array): number | undefined {
  let at = 0;
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // ID3v2：10バイトの頭＋同期安全な4バイトの長さ
    at = 10 + ((bytes[6] & 0x7f) << 21) + ((bytes[7] & 0x7f) << 14) + ((bytes[8] & 0x7f) << 7) + (bytes[9] & 0x7f);
  }
  for (let i = at; i + 3 < bytes.length; i += 1) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1] >> 3) & 0x3; // 3: MPEG1、2: MPEG2、0: MPEG2.5、1: 予約
    const layer = (bytes[i + 1] >> 1) & 0x3; // 0: 予約
    const index = (bytes[i + 2] >> 2) & 0x3; // 3: 予約
    if (version === 1 || layer === 0 || index === 3) continue;
    const table = version === 3 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
    return table[index];
  }
  return undefined;
}

/* ── 見本の話 ── */

/** 見本の文（作り物）。1文が15〜45字ほどで、地の文と会話をまぜる */
export const SENTENCES = [
  "朝の駅前は、まだ人の数もまばらだった。",
  "「おはよう、今日は早いね」と彼女は笑った。",
  "改札を抜けると、冷たい風が頬をなでていく。",
  "ベンチに腰をおろして、ぼんやりと空を見上げた。",
  "「あの雲、どこまで行くんだろうね」と僕はつぶやいた。",
  "遠くで電車の走り出す音が聞こえる。",
  "彼女は鞄から小さな包みを取り出して、僕に差し出した。",
  "「これ、昨日の夜に焼いたの。よかったら食べて」",
  "包みを開くと、甘い匂いがふわりと広がった。",
  "ひと口かじると、やさしい味が口の中にしみていく。",
  "「おいしいよ。ありがとう」と僕はうなずいた。",
  "彼女はほっとしたように、肩の力をぬいた。",
  "駅の時計は、八時をすこし過ぎたところを指している。",
  "「そろそろ行かないと、遅れちゃうね」",
  "僕たちは並んで、長い坂道を上りはじめた。",
  "道の両側には、古い家が静かに並んでいる。",
  "角の花屋の前で、店主が水をまいていた。",
  "「いってらっしゃい」と、おじいさんが手を振る。",
  "僕たちは軽く頭を下げて、足を速めた。",
  "坂の上には、白い校舎が朝日に光っている。",
];

/** `count` 文ぶんの見本の話を作る。同じ文が続かないよう、巡るたびに段落を替える */
export function sampleEpisode(name: string, marker: string, count: number): FixtureEpisode {
  const paragraphs: string[] = [];
  let current = "";
  for (let i = 0; i < count; i += 1) {
    current += SENTENCES[i % SENTENCES.length];
    if (i % 5 === 4) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current) paragraphs.push(current);
  // 開くときの目印。先頭の段落の頭に置く
  paragraphs[0] = `${marker}。${paragraphs[0]}`;
  return { name, text: `${paragraphs.join("\n\n")}\n` };
}

/* ── 本物のエンジンの前の中継 ── */

export interface Logged {
  path: string;
  start: number;
  end?: number;
  status?: number;
  bytes?: number;
  textLength?: number;
  /** 本文を運ぶ頼みの本文（見本の話の字。作者の作品は入れない） */
  text?: string;
  /** `speaker`（スタイルの番号） */
  speaker?: string;
}

export interface RecordingProxy {
  url: string;
  log: Logged[];
  close: () => Promise<void>;
}

/** 本物のエンジンの前の中継。頼みをそのまま渡し、道・時刻・大きさ・本文・スタイルの番号を控える */
export async function startRecordingProxy(engine: VoiceEngineId = "aivisspeech"): Promise<RecordingProxy> {
  const real = REAL_URL[engine];
  const realHost = new URL(real).host;
  const log: Logged[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", real);
      const entry: Logged = { path: url.pathname, start: Date.now() };
      const text = url.searchParams.get("text");
      if (text) {
        entry.textLength = text.length;
        entry.text = text;
      }
      const speaker = url.searchParams.get("speaker");
      if (speaker) entry.speaker = speaker;
      log.push(entry);
      const upstream = http.request(`${real}${req.url ?? "/"}`, { method: req.method, headers: { ...req.headers, host: realHost } }, (up) => {
        const parts: Buffer[] = [];
        up.on("data", (chunk: Buffer) => parts.push(chunk));
        up.on("end", () => {
          const out = Buffer.concat(parts);
          entry.end = Date.now();
          entry.status = up.statusCode;
          entry.bytes = out.length;
          res.writeHead(up.statusCode ?? 502, up.headers);
          res.end(out);
        });
      });
      upstream.on("error", (error) => {
        entry.end = Date.now();
        entry.status = -1;
        res.writeHead(502);
        res.end(String(error));
      });
      upstream.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 使うエンジンの中継の接続先を、拡張機能の設定へ向ける。使わないほうは誰も待たない口 */
export function engineSettings(urls: { aivisspeech?: string; voicevox?: string }): Record<string, unknown> {
  return {
    "novelai.readAloud.aivisSpeechUrl": urls.aivisspeech ?? DEAD_URL,
    "novelai.readAloud.voicevoxUrl": urls.voicevox ?? DEAD_URL,
  };
}

/** 本物のエンジンの話者の一覧（製品と同じ読み方）。選ぶ声を決めるために、起こす前に引く */
export async function realSpeakers(engine: VoiceEngineId): Promise<VoiceSpeaker[]> {
  const response = await fetch(`${REAL_URL[engine]}/speakers`);
  if (!response.ok) throw new Error(`${engine} の話者の一覧が取れません（HTTP ${response.status}）`);
  return parseSpeakers(await response.json());
}

export function synthDone(log: Logged[], since: number): Logged[] {
  return log.filter((entry) => entry.path === "/synthesis" && entry.start >= since && entry.end !== undefined && entry.status === 200);
}

/* ── 作品の用意（起こす前。`LaunchOptions.prepareWork`） ── */

/** 人物の記録（AI は呼ばない）。この話の章番号（1）に登場する人物として置く */
export function realCharacter(id: string, name: string): Character {
  return { ...emptyCharacter(id, name), appearedChapters: [1] };
}

export async function writeCharacters(workFolder: string, characters: readonly Character[]): Promise<void> {
  const folder = defaultCharactersFolder(workFolder);
  await mkdir(folder, { recursive: true });
  for (const character of characters) {
    await writeFile(path.join(folder, characterFileName(character)), JSON.stringify(character, null, 2), "utf8");
  }
}

export interface RealVoice {
  engine: VoiceEngineId;
  speaker: VoiceSpeaker;
  styleIndex?: number;
}

function voiceRef(voice: RealVoice): Record<string, unknown> {
  const style = voice.speaker.styles[voice.styleIndex ?? 0];
  return { speakerUuid: voice.speaker.uuid, speakerName: voice.speaker.name, styleName: style.name, styleId: style.id, engine: voice.engine };
}

/** `.aiwriter/voices.json`（声の割り当て。作者が［声の割り当て］で選んだのと同じ形） */
export async function writeVoices(
  workFolder: string,
  voices: { narrator?: RealVoice; dialogueDefault?: RealVoice; characters?: Array<{ id: string; name: string; voice: RealVoice }> }
): Promise<void> {
  const aiwriter = path.join(workFolder, ".aiwriter");
  await mkdir(aiwriter, { recursive: true });
  const characters: Record<string, unknown> = {};
  for (const item of voices.characters ?? []) characters[item.id] = { ...voiceRef(item.voice), characterName: item.name };
  await writeFile(
    path.join(aiwriter, "voices.json"),
    JSON.stringify({
      version: 1,
      ...(voices.narrator ? { narrator: voiceRef(voices.narrator) } : {}),
      ...(voices.dialogueDefault ? { dialogueDefault: voiceRef(voices.dialogueDefault) } : {}),
      characters,
    }),
    "utf8"
  );
}

/** 台詞の話者と感情の控え（`.aiwriter/voiceCast/<話>.json`。作者が直した形＝AI は呼ばない道） */
export async function writeCast(
  folders: { workFolder: string; manuscriptFolder: string },
  episodeFile: string,
  entries: ReadonlyArray<Pick<CastEntry, "quote" | "nth" | "speakerId" | "speakerName" | "emotion" | "intensity">>
): Promise<void> {
  const aiwriter = path.join(folders.workFolder, ".aiwriter");
  await mkdir(path.join(aiwriter, "voiceCast"), { recursive: true });
  const relative = path.relative(folders.workFolder, path.join(folders.manuscriptFolder, episodeFile)).replace(/\\/g, "/");
  await writeFile(
    path.join(aiwriter, "voiceCast", readingDictionaryFileName(relative)),
    JSON.stringify({ version: 1, episode: relative, entries: entries.map((entry) => ({ ...entry, source: "author" })) }),
    "utf8"
  );
}

/** 話の中の台詞を数え、`pick` が人物を返したものだけを台詞の控えにする（感情は平静・強さは中） */
export function castBySpeaker(text: string, pick: (index: number, quote: string) => { id: string; name: string } | undefined): Array<Pick<CastEntry, "quote" | "nth" | "speakerId" | "speakerName" | "emotion" | "intensity">> {
  const entries: Array<Pick<CastEntry, "quote" | "nth" | "speakerId" | "speakerName" | "emotion" | "intensity">> = [];
  for (const dialogue of castDialogues(text)) {
    const who = pick(dialogue.index, dialogue.quote);
    if (who) entries.push({ quote: dialogue.quote, nth: dialogue.nth, speakerId: who.id, speakerName: who.name, emotion: "平静", intensity: "中" });
  }
  return entries;
}

/* ── 画面の操作 ── */

export async function aloudNote(frame: Frame): Promise<string> {
  return frame.locator("#aloudNote").innerText().catch(() => "");
}

/** 話を開き、読み上げの列を出して、［声］をそのエンジンにして、［▶ 読む］が押せるまで待つ */
export async function openRow(session: E2ESession, file: string, marker: string, engine: VoiceEngineId): Promise<Frame> {
  const frame = await openEpisode(session.page, file, marker);
  await clickToolButton(frame, "aloudToggle");
  await waitUntil(async () => (await frame.locator(`#aloudEngine option[value="${engine}"]`).isDisabled().catch(() => true)) === false, "［声］で人物の声が選べる", 60_000);
  if ((await frame.locator("#aloudEngine").inputValue()) !== engine) await frame.locator("#aloudEngine").selectOption(engine);
  await waitUntil(async () => !(await frame.locator("#aloudPlay").isDisabled()), "［▶ 読む］が押せる", 60_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列の注：${JSON.stringify(await aloudNote(frame))}）`);
  });
  return frame;
}

export async function slowCount(session: E2ESession, since: number): Promise<number> {
  return (await recordedNotices(session)).filter((entry) => Date.parse(entry.at) >= since - 1_000 && entry.message.includes(SLOW_NOTICE)).length;
}

/**
 * 読んでいる間、真ん中の窓が出ないかを見続け、合成が `need` 件そろうか、読み終わるまで待つ。
 * `need` に大きな数を渡すと、読み終わるまで待つ
 */
export async function readUntil(
  session: E2ESession,
  frame: Frame,
  proxies: readonly RecordingProxy[],
  since: number,
  need: number,
  limitMs: number
): Promise<{ dialogs: string[]; done: number; playing: boolean }> {
  const total = (): number => proxies.reduce((sum, proxy) => sum + synthDone(proxy.log, since).length, 0);
  const isPlaying = async (): Promise<boolean> => !(await frame.locator("#aloudPlay").innerText().catch(() => "")).includes("読む");
  const dialogs: string[] = [];
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const shown = await dialogText(session.page);
    if (shown && !dialogs.includes(shown)) dialogs.push(shown);
    if (shown) break;
    const done = total();
    const playing = await isPlaying();
    if (done >= need) return { dialogs, done, playing };
    if (!playing && done > 0) return { dialogs, done, playing };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { dialogs, done: total(), playing: await isPlaying() };
}

export async function stopReading(frame: Frame): Promise<void> {
  if (!(await frame.locator("#aloudStop").isDisabled().catch(() => true))) await frame.locator("#aloudStop").click();
  await waitUntil(async () => (await frame.locator("#aloudPlay").innerText()).includes("読む"), "［▶ 読む］に戻る", 30_000);
}

export async function waitExportConfirm(page: Page): Promise<string> {
  let text = "";
  await waitUntil(
    async () => {
      const rows = (await quickPickRows(page)).map((row) => row.label);
      text = [(await quickPickTitle(page)) ?? "", ...rows].join("\n");
      return text.replace(/\s+/g, "").includes("を人物の声で音声（MP3）に書き出します");
    },
    "書き出しの確認の窓が出る",
    120_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}／右下：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
  });
  return text;
}

export interface ExportResult {
  confirm: string;
  files: string[];
  dialogs: string[];
  seconds: number;
  /** 作ったフォルダーの絶対の道（起こした VS Code が閉じる前に写すために） */
  folder: string;
  mp3Rates: Record<string, number | undefined>;
  credits: string;
}

/**
 * 列の［音声に書き出す］を押し、確認の窓の［書き出す］を押して、MP3 と「クレジットと利用条件.txt」が
 * できるまで待つ。真ん中の窓が出たら止める（`dialogs` に残る）。できたものは `keepAs`（置き場の下の名前）へ写す
 */
export async function exportEpisode(session: E2ESession, frame: Frame, stem: string, keepAs: string, limitMs: number): Promise<ExportResult> {
  const { page } = session;
  await waitUntil(async () => frame.locator("#aloudVoiceExport").isVisible().catch(() => false), "［音声に書き出す］が出る", 20_000);
  await frame.locator("#aloudVoiceExport").click();
  const confirm = await waitExportConfirm(page);
  const rows = await quickPickRows(page);
  const index = rows.findIndex((row) => row.label === "書き出す");
  if (index < 0) throw new Error(`確認の窓に［書き出す］がありません：${JSON.stringify(rows)}`);
  const since = Date.now();
  await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").nth(index).click();
  const folder = path.join(session.workFolder, ".aiwriter", "exports", "音声", stem);
  const dialogs: string[] = [];
  let files: string[] = [];
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const shown = await dialogText(page);
    if (shown) {
      dialogs.push(shown);
      break;
    }
    files = await readdir(folder, { recursive: true }).then((list) => list.map(String)).catch(() => []);
    if (files.some((file) => file.endsWith(".mp3")) && files.includes("クレジットと利用条件.txt")) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  // 書き込み途中のファイルを写さないよう、少し待つ
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  files = await readdir(folder, { recursive: true }).then((list) => list.map(String)).catch(() => []);
  const mp3Rates: Record<string, number | undefined> = {};
  for (const file of files.filter((name) => name.endsWith(".mp3"))) {
    mp3Rates[file] = mp3SampleRate(await readFile(path.join(folder, file)));
  }
  const credits = await readFile(path.join(folder, "クレジットと利用条件.txt"), "utf8").catch(() => "");
  await copyTree(folder, path.join(await outDir(), keepAs));
  return { confirm, files, dialogs, seconds: Math.round((Date.now() - since) / 1000), folder, mp3Rates, credits };
}
