import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { notationModeFor } from "../../src/core/manuscriptRender";
import {
  parseReadingDictionary,
  readingDictionaryFileName,
  readingSpansFor,
  type ReadingEntry,
} from "../../src/core/readingDictionary";
import {
  collectKnownReadings,
  describeReadingSource,
  findMisreadCandidates,
  judgeMisreads,
  type KnownReadingEpisode,
} from "../../src/core/readingMisread";
import { VoiceEngineClient } from "../../src/core/voiceEngine";

/**
 * 読み間違いの見込み（設計書6.42.6）を、本物の AivisSpeech と実データの作品で測る台本。
 * **検査ではない**（`npm run check` に入らない）。製品と同じ判定の関数（`core/readingMisread.ts`）を通し、
 * 見込みを1行ずつ書き出す。見逃し（読み違えているのに出ない）と誤検出（読めているのに出る）は、
 * 書き出した表を作者・担当が聞いて／読んで数える（正解はこの台本の外で作る）。
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"   # 場所はソースに書かない
 *   $env:RM_RUN = "1"                                            # これが無ければ飛ばす
 *   $env:RM_ENGINE = "http://127.0.0.1:10101"                    # 省けば AivisSpeech の既定
 *   $env:RM_WORK = "作品フォルダーの名前"                         # 省けば全作品
 *   $env:RM_STYLE = "888753760"                                  # 省けばエンジンの最初の話者の最初の声
 *   $env:RM_OUT = "出力先フォルダー"                              # 省けば各作品の .aiwriter/logs/（Git の除外の中）
 *   npx vitest run --config vitest.live.config.mts test/live/readingMisreadAcrossWorks.test.ts
 *
 * - **原稿は読むだけ。** 書くのは出力の表だけ（`RM_OUT` か、各作品の `.aiwriter/logs/`。どちらも同期しない所）
 * - **本文を送る相手は手元のエンジンだけ**（`RM_ENGINE`。127.0.0.1 以外を書くと止める）。頼むのは audio_query だけで、音声は作らない
 * - 製品との違い：設定資料の名前の読み（`設定/`）と IME の読みは使わない（読み込みが VS Code の部品にある）。
 *   ルビと読みの辞書（`.aiwriter/readings/`）の読みだけで測る。読み上げで置き換える範囲も読みの辞書だけ
 * - 出力の列：話・行・原稿の字・エンジンの読み・正しい読み・どこから知ったか・送った文
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();
const RUN = process.env.RM_RUN === "1";
const ENGINE = (process.env.RM_ENGINE?.trim() || "http://127.0.0.1:10101").replace(/\/+$/, "");
const ONLY = process.env.RM_WORK?.trim();
const STYLE = process.env.RM_STYLE?.trim();
const OUT = process.env.RM_OUT?.trim();

function readText(file: string): string {
  const raw = fs.readFileSync(file);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    // 投稿サイトの書き出しなどで Shift_JIS の原稿がある
    text = new TextDecoder("shift_jis").decode(raw);
  }
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** 作品の話（.txt・.md）。2段まで下る。隠しフォルダー・backups・プロットは読まない */
function episodesOf(workFolder: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (depth < 2 && !entry.name.startsWith(".") && entry.name !== "backups" && entry.name !== "設定") {
          walk(path.join(dir, entry.name), depth + 1);
        }
      } else if (/\.(txt|md)$/i.test(entry.name) && !/^about/i.test(entry.name) && !/plot/i.test(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(workFolder, 0);
  return files.sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
}

function dictionaryOf(workFolder: string, file: string): ReadingEntry[] {
  const relative = path.relative(workFolder, file).replace(/\\/g, "/");
  const target = path.join(workFolder, ".aiwriter", "readings", readingDictionaryFileName(relative));
  if (!fs.existsSync(target)) return [];
  try {
    return parseReadingDictionary(fs.readFileSync(target, "utf8")).entries;
  } catch (error) {
    // 壊れた辞書は直さない（製品と同じ）。使わずに測る
    console.warn(`読みの辞書を使えません：${target}（${error instanceof Error ? error.message : String(error)}）`);
    return [];
  }
}

const cell = (value: string): string => value.replace(/[\t\n]/g, " ");

describe.skipIf(!RUN || !ROOT)("読み間違いの見込み（本物のエンジン・実データ）", () => {
  test(
    "作品ごとに、見込みを1行ずつ書き出す",
    async () => {
      expect(new URL(ENGINE).hostname, "本文を送るのは手元のエンジンだけ").toBe("127.0.0.1");
      const client = new VoiceEngineClient(ENGINE);
      const style = STYLE ? Number(STYLE) : (await client.speakers())[0]?.styles[0]?.id;
      expect(style, "エンジンに話者がいません").toBeTypeOf("number");

      const works = fs
        .readdirSync(ROOT as string, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "backups" && (!ONLY || entry.name === ONLY));
      for (const workEntry of works) {
        const workFolder = path.join(ROOT as string, workEntry.name);
        const files = episodesOf(workFolder);
        if (files.length === 0) continue;
        const episodes: KnownReadingEpisode[] = files.map((file, index) => ({
          label: `第${index + 1}話（${path.basename(file)}）`,
          text: readText(file),
          notation: notationModeFor(file),
          dictionary: dictionaryOf(workFolder, file),
        }));
        const known = collectKnownReadings(episodes, []);
        const rows = ["話\t行\t原稿の字\tエンジンの読み\t正しい読み\tどこから知ったか\t送った文"];
        let asked = 0;
        for (const episode of episodes) {
          const spans = readingSpansFor(episode.text, episode.dictionary).spans;
          const { candidates } = findMisreadCandidates(episode.text, episode.notation, spans, known);
          asked += candidates.length;
          const found = await judgeMisreads(candidates, (speech) => client.audioQuery(speech, style as number));
          for (const item of found) {
            rows.push(
              [
                episode.label,
                String(item.candidate.line),
                item.candidate.word,
                item.engineReading,
                item.expected.reading,
                describeReadingSource(item.expected.source),
                item.candidate.speech,
              ]
                .map(cell)
                .join("\t")
            );
          }
        }
        const outFolder = OUT ?? path.join(workFolder, ".aiwriter", "logs");
        fs.mkdirSync(outFolder, { recursive: true });
        const outFile = path.join(outFolder, `readingMisread-${OUT ? `${workEntry.name}-` : ""}${new Date().toISOString().slice(0, 10)}.tsv`);
        fs.writeFileSync(outFile, `${rows.join("\n")}\n`, "utf8");
        console.log(`${workEntry.name}：分かっている読み ${known.size}語・問うた所 ${asked}・見込み ${rows.length - 1}件 → ${outFile}`);
      }
    },
    6 * 60 * 60_000
  );
});
