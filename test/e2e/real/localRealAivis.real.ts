/**
 * 本物の AivisSpeech（127.0.0.1:10101）へ向けた画面の自動テスト（実機確認リストの 48・74・49・80 の前半）。
 * 2026-11-09 母艦の頼み「手のいらない実機確認をノートPCで回してください」で書き、2026-11-12 に取り込んだ。
 *
 * 見張ること：
 *  - 48：読み上げが、10文以上つづく（真ん中の窓が出ず、合成が10文以上できる）
 *  - 74：声づくりが読む速さに追いつかないときの知らせは、1回の読み上げで1回。押し直すとまた1回
 *  - 49：長い話を列の［音声に書き出す］で書き出すと、止まらずに MP3 ができる
 *  - 80：書き出しのとき、本物のライセンス（クレジットと利用条件）で止まらず、ライセンスの控えもできる
 *
 * ## なぜ `test/e2e` の全件（`npm run test:e2e`）に入れないか
 * 本物の AivisSpeech が要り、1件が数分〜30分かかる（CPU の機械で 48・74 が約4分半、49・80 が約32分）。
 * 無い機械では落ちるので、**`*.real.ts` という名前にして E2E の設定（`*.test.ts`）に拾われないようにし、
 * 専用の設定 `vitest.real.config.mts`（`npm run test:e2e:real`）からだけ流す**（`manual:shots` の `*.shots.ts` と同じ分け方）。
 * `npm run check`・CI・配布の検査（package:vsix）にも入らない。
 * さらに環境変数 `NOVELAI_REAL_AIVIS=1` が無いときは、専用の設定で流しても飛ばす（落とさない）。
 *
 * ## 流し方（長い処理なので、機械が眠らないようにする）
 * 1. AivisSpeech を起動しておく（127.0.0.1:10101 が応えること）。
 * 2. `npm run build`（`test:e2e:real` が先に流す）。
 * 3. 環境変数 `ELECTRON_RUN_AS_NODE` を外す。`NOVELAI_REAL_AIVIS=1` を入れる。
 *    控えの置き場は `NOVELAI_REAL_OUT`（無ければ一時フォルダーの novelai-real-aivis）。
 * 4. 眠らせない（Windows のノートPCは Modern Standby で本体が止まる）：スキル `e2e` の「本物の AivisSpeech で流す」の節。
 *
 * ```powershell
 * $env:ELECTRON_RUN_AS_NODE = $null
 * $env:NOVELAI_REAL_AIVIS = "1"
 * $env:NOVELAI_REAL_OUT = "$HOME\novelai-real-out"
 * npm run test:e2e:real
 * ```
 *
 * ## 作り方
 * - 本物のエンジンの前に、頼みを控えるだけの中継を 127.0.0.1 に立てる（本文を運ぶ頼みの数と、声づくりにかかった時間を数えるため。
 *   中身は書き換えずにそのまま渡す）。拡張機能の設定 `novelai.readAloud.aivisSpeechUrl` を中継へ向ける。
 * - **本文は、このファイルの中で作った見本の話**（作者の作品を入れない。作品の場所はソースに書かない決まり）。
 *   長い話は約 3,000 字・137 文（作者の作品で32分かかった第16話と同じ大きさ）。
 * - 結果の控えは `NOVELAI_REAL_OUT` へ JSON と MP3 の写しで残す。
 */
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { clickToolButton, openEpisode } from "../support/manuscriptFrame";
import { describeNotices, recordedNotices } from "../support/noticeRecord";
import { withVsCode, type E2ESession, type FixtureEpisode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { dialogText, notificationTexts, quickInputWaitContext, quickPickRows, quickPickTitle } from "../support/workbenchDom";

const ENABLED = process.env.NOVELAI_REAL_AIVIS === "1";
const REAL = "http://127.0.0.1:10101";
const OUT = process.env.NOVELAI_REAL_OUT ?? path.join(process.env.TEMP ?? ".", "novelai-real-aivis");
const SLOW = "この PC では、AivisSpeech の声づくりが読む速さに追いついていません";

/** 見本の文（作り物）。1文が15〜45字ほどで、地の文と会話をまぜる */
const SENTENCES = [
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
function sampleEpisode(name: string, marker: string, count: number): FixtureEpisode {
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

interface Logged {
  path: string;
  start: number;
  end?: number;
  status?: number;
  bytes?: number;
  textLength?: number;
}

/** 本物のエンジンの前の中継。頼みをそのまま渡し、道・時刻・大きさを控える */
async function startRecordingProxy(): Promise<{ url: string; log: Logged[]; close: () => Promise<void> }> {
  const log: Logged[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", REAL);
      const entry: Logged = { path: url.pathname, start: Date.now() };
      const text = url.searchParams.get("text");
      if (text) entry.textLength = text.length;
      log.push(entry);
      const upstream = http.request(
        `${REAL}${req.url ?? "/"}`,
        { method: req.method, headers: { ...req.headers, host: "127.0.0.1:10101" } },
        (up) => {
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
        }
      );
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

const settings = (url: string): Record<string, unknown> => ({
  "novelai.readAloud.aivisSpeechUrl": url,
  "novelai.readAloud.voicevoxUrl": "http://127.0.0.1:9",
});

async function aloudNote(frame: Frame): Promise<string> {
  return frame.locator("#aloudNote").innerText().catch(() => "");
}

async function openRow(session: E2ESession, file: string, marker: string): Promise<Frame> {
  const frame = await openEpisode(session.page, file, marker);
  await clickToolButton(frame, "aloudToggle");
  await waitUntil(async () => (await frame.locator('#aloudEngine option[value="aivisspeech"]').isDisabled().catch(() => true)) === false, "［声］で人物の声が選べる", 60_000);
  if ((await frame.locator("#aloudEngine").inputValue()) !== "aivisspeech") await frame.locator("#aloudEngine").selectOption("aivisspeech");
  await waitUntil(async () => !(await frame.locator("#aloudPlay").isDisabled()), "［▶ 読む］が押せる", 60_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列の注：${JSON.stringify(await aloudNote(frame))}）`);
  });
  return frame;
}

async function slowCount(session: E2ESession, since: number): Promise<number> {
  return (await recordedNotices(session)).filter((entry) => Date.parse(entry.at) >= since - 1_000 && entry.message.includes(SLOW)).length;
}

function synthDone(log: Logged[], since: number): Logged[] {
  return log.filter((entry) => entry.path === "/synthesis" && entry.start >= since && entry.end !== undefined && entry.status === 200);
}

/** 読んでいる間、真ん中の窓が出ないかを見続け、合成が `need` 件そろうまで待つ */
async function readUntil(session: E2ESession, frame: Frame, log: Logged[], since: number, need: number, limitMs: number): Promise<{ dialogs: string[]; done: number; playing: boolean }> {
  const dialogs: string[] = [];
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const shown = await dialogText(session.page);
    if (shown && !dialogs.includes(shown)) dialogs.push(shown);
    if (shown) break;
    const done = synthDone(log, since).length;
    const playing = !(await frame.locator("#aloudPlay").innerText().catch(() => "")).includes("読む");
    if (done >= need) return { dialogs, done, playing };
    if (!playing && done > 0) return { dialogs, done, playing };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { dialogs, done: synthDone(log, since).length, playing: !(await frame.locator("#aloudPlay").innerText().catch(() => "")).includes("読む") };
}

async function stop(frame: Frame): Promise<void> {
  if (!(await frame.locator("#aloudStop").isDisabled().catch(() => true))) await frame.locator("#aloudStop").click();
  await waitUntil(async () => (await frame.locator("#aloudPlay").innerText()).includes("読む"), "［▶ 読む］に戻る", 30_000);
}

function summarize(log: Logged[], since: number): Array<Record<string, unknown>> {
  return log
    .filter((entry) => entry.start >= since && (entry.path === "/synthesis" || entry.path === "/audio_query"))
    .map((entry) => ({ path: entry.path, ms: entry.end !== undefined ? entry.end - entry.start : null, status: entry.status, bytes: entry.bytes, textLength: entry.textLength }));
}

test.skipIf(!ENABLED)("48・74：本物の AivisSpeech（CPU）で1話を読み続け、遅さの知らせは1回の読み上げで1回、押し直すとまた1回", async () => {
  await mkdir(OUT, { recursive: true });
  const proxy = await startRecordingProxy();
  // 10文以上を読ませる（48）ぶんの長さ。見本の話（作り物）
  const ep = sampleEpisode("episode_0001_朝の坂道.md", "朝の駅前", 20);
  const result: Record<string, unknown> = { episode: ep.name, chars: ep.text.length };
  try {
    await withVsCode(
      "本物のAivisSpeechで読む",
      [ep],
      async (session) => {
        const frame = await openRow(session, ep.name, "朝の駅前");
        /* ── 1回目（48） ── */
        const since1 = Date.now();
        await frame.locator("#aloudPlay").click();
        const first = await readUntil(session, frame, proxy.log, since1, 11, 15 * 60_000);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        result.first = { ...first, slowNotices: await slowCount(session, since1), seconds: Math.round((Date.now() - since1) / 1000), note: await aloudNote(frame), notices: await describeNotices(session, since1), requests: summarize(proxy.log, since1) };
        await stop(frame);
        /* ── 押し直す（74） ── */
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const since2 = Date.now();
        await frame.locator("#aloudPlay").click();
        const second = await readUntil(session, frame, proxy.log, since2, 8, 10 * 60_000);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        result.second = { ...second, slowNotices: await slowCount(session, since2), seconds: Math.round((Date.now() - since2) / 1000), notices: await describeNotices(session, since2), requests: summarize(proxy.log, since2) };
        result.allSlowMessages = (await recordedNotices(session)).filter((entry) => entry.message.includes(SLOW)).map((entry) => `${entry.at} ${entry.message}`);
        await stop(frame);
      },
      { settings: settings(proxy.url) }
    );
  } finally {
    await writeFile(path.join(OUT, "read_48_74.json"), JSON.stringify(result, null, 2), "utf8");
    await proxy.close();
  }
  const first = result.first as { dialogs: string[]; done: number; slowNotices: number };
  const second = result.second as { dialogs: string[]; slowNotices: number };
  expect(first.dialogs, "1回目に真ん中の窓が出た").toEqual([]);
  expect(first.done, "1回目に合成できた文の数").toBeGreaterThanOrEqual(10);
  expect(first.slowNotices, "1回目の遅さの知らせの数").toBe(1);
  expect(second.dialogs, "2回目に真ん中の窓が出た").toEqual([]);
  expect(second.slowNotices, "2回目の遅さの知らせの数").toBe(1);
}, 30 * 60_000);

async function waitExportConfirm(page: Page): Promise<string> {
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

test.skipIf(!ENABLED)("49・80：本物の AivisSpeech（CPU）で、長い話（約3,000字・137文）を列の［音声に書き出す］で書き出し、止まらずに MP3 とライセンスができる", async () => {
  await mkdir(OUT, { recursive: true });
  const proxy = await startRecordingProxy();
  const ep = sampleEpisode("episode_0016_長い坂道.md", "夕方の駅前", 137);
  const stem = ep.name.replace(/\.md$/, "");
  const result: Record<string, unknown> = { episode: ep.name, chars: ep.text.length };
  try {
    await withVsCode(
      "本物のAivisSpeechで書き出す",
      [ep],
      async (session) => {
        const { page } = session;
        const frame = await openRow(session, ep.name, "夕方の駅前");
        await waitUntil(async () => frame.locator("#aloudVoiceExport").isVisible().catch(() => false), "［音声に書き出す］が出る", 20_000);
        await frame.locator("#aloudVoiceExport").click();
        result.confirm = await waitExportConfirm(page);
        const rows = await quickPickRows(page);
        const index = rows.findIndex((row) => row.label === "書き出す");
        expect(index, `確認の窓の行：${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(0);
        const since = Date.now();
        await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").nth(index).click();
        const folder = path.join(session.workFolder, ".aiwriter", "exports", "音声", stem);
        const dialogs: string[] = [];
        let files: string[] = [];
        const until = Date.now() + 45 * 60_000;
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
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        files = await readdir(folder, { recursive: true }).then((list) => list.map(String)).catch(() => []);
        result.seconds = Math.round((Date.now() - since) / 1000);
        result.dialogs = dialogs;
        result.files = files;
        result.notices = await describeNotices(session, since);
        result.synthesis = synthDone(proxy.log, since).length;
        result.failedRequests = proxy.log.filter((entry) => entry.start >= since && entry.status !== 200).map((entry) => ({ path: entry.path, status: entry.status }));
        const keep = path.join(OUT, "export_49_80");
        await mkdir(keep, { recursive: true });
        for (const file of files) {
          const from = path.join(folder, file);
          const to = path.join(keep, file);
          await mkdir(path.dirname(to), { recursive: true });
          await copyFile(from, to).catch(() => undefined);
        }
      },
      { settings: settings(proxy.url) }
    );
  } finally {
    await writeFile(path.join(OUT, "export_49_80.json"), JSON.stringify(result, null, 2), "utf8");
    await proxy.close();
  }
  expect(result.dialogs, "書き出しの途中で真ん中の窓が出た").toEqual([]);
  expect((result.files as string[]).some((file) => file.endsWith(".mp3")), `できたファイル：${JSON.stringify(result.files)}`).toBe(true);
  // 80：本物のライセンスで止まらず、クレジットと利用条件・ライセンスの全文の控えまでできている
  expect(result.files as string[], "クレジットと利用条件").toContain("クレジットと利用条件.txt");
  expect((result.files as string[]).some((file) => file.startsWith("ライセンス") && file.endsWith(".txt")), `ライセンスの全文：${JSON.stringify(result.files)}`).toBe(true);
}, 50 * 60_000);
