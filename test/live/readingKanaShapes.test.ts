import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectKnownReadings, findMisreadCandidates, judgeMisreads } from "../../src/core/readingMisread";
import { VoiceEngineClient } from "../../src/core/voiceEngine";

/**
 * 読み間違いの見込み（設計書6.42.5）の、かなをならす決まりを本物のエンジンで測る台本。
 * **検査ではない**（`npm run check` に入らない）。作品は使わず、読みの分かっている語を並べた表で問う。
 *
 * 作者の作品にはルビと読みの辞書がほとんど無く、実データでは問う語が0件だった（2026-11-17）。
 * そこで、製品と同じ道（ルビ1回→2回目は漢字のまま→`findMisreadCandidates`→`judgeMisreads`）を、
 * 語ごとに作った2行の本文で通す。
 *
 * - `READ_RIGHT`：エンジンがふつうに読めるはずの語。長音（オウ・エイ）・ヂ・ヅ・ジョオウなど、
 *   ならす決まりが要る形を集めた。**出たら誤検出**（ならし方の穴）
 * - `ATEJI`：当て読み。エンジンは辞書の読みで読むはずなので、**出なければ見逃し**
 *
 *   $env:RK_RUN = "1"
 *   $env:RM_ENGINE = "http://127.0.0.1:10101"   # 省けば AivisSpeech の既定
 *   $env:RM_OUT = "出力先フォルダー"              # 省けば書き出さない
 *   npx vitest run --config vitest.live.config.mts test/live/readingKanaShapes.test.ts
 */
const RUN = process.env.RK_RUN === "1";
const ENGINE = (process.env.RM_ENGINE?.trim() || "http://127.0.0.1:10101").replace(/\/+$/, "");
const OUT = process.env.RM_OUT?.trim();

const READ_RIGHT: Array<[string, string]> = [
  ["東京", "とうきょう"], ["先生", "せんせい"], ["経営", "けいえい"], ["王様", "おうさま"], ["学校", "がっこう"],
  ["映画", "えいが"], ["鼻血", "はなぢ"], ["三日月", "みかづき"], ["手続", "てつづき"], ["綺麗", "きれい"],
  ["丁寧", "ていねい"], ["時計", "とけい"], ["公園", "こうえん"], ["少女", "しょうじょ"], ["今日", "きょう"],
  ["図書館", "としょかん"], ["警察", "けいさつ"], ["世界", "せかい"], ["動物", "どうぶつ"], ["教科書", "きょうかしょ"],
  ["冒険者", "ぼうけんしゃ"], ["資産", "しさん"], ["運用", "うんよう"], ["女王", "じょおう"], ["金融", "きんゆう"],
  ["未亡人", "みぼうじん"], ["生活", "せいかつ"], ["氷河", "ひょうが"], ["大通り", "おおどおり"], ["遠回り", "とおまわり"],
  ["弟子", "でし"], ["勇者", "ゆうしゃ"], ["魔法", "まほう"], ["魔王", "まおう"], ["数字", "すうじ"],
  ["空気", "くうき"], ["携帯", "けいたい"], ["丁度", "ちょうど"], ["優勝", "ゆうしょう"], ["相続", "そうぞく"],
];
const ATEJI: Array<[string, string]> = [
  ["本気", "まじ"], ["強敵", "とも"], ["宇宙", "そら"], ["運命", "さだめ"], ["未来", "あした"],
  ["地球", "ほし"], ["仲間", "とも"], ["真実", "まこと"], ["永遠", "とわ"], ["故郷", "くに"],
];

interface Row {
  group: "read_right" | "ateji";
  word: string;
  reading: string;
  flagged: boolean;
  engineReading: string;
}

async function judge(client: VoiceEngineClient, style: number, word: string, reading: string): Promise<{ flagged: boolean; engineReading: string; asked: number }> {
  // 製品と同じ形：1行目でルビを振り、2行目は漢字のまま（そこが問われる）
  const text = `　{${word}|${reading}}を見た。\n　ここで${word}を見た。\n`;
  const known = collectKnownReadings([{ label: "表", text, notation: "curly", dictionary: [] }], []);
  const { candidates } = findMisreadCandidates(text, "curly", [], known);
  const found = await judgeMisreads(candidates, (speech) => client.audioQuery(speech, style));
  return { flagged: found.length > 0, engineReading: found[0]?.engineReading ?? "", asked: candidates.length };
}

describe.skipIf(!RUN)("かなのならし方（本物のエンジン・語の表）", () => {
  test(
    "読めるはずの語は出ず、当て読みは出る",
    async () => {
      expect(new URL(ENGINE).hostname, "本文を送るのは手元のエンジンだけ").toBe("127.0.0.1");
      const client = new VoiceEngineClient(ENGINE);
      const style = (await client.speakers())[0]?.styles[0]?.id;
      expect(style, "エンジンに話者がいません").toBeTypeOf("number");
      const rows: Row[] = [];
      const notAsked: string[] = [];
      for (const [group, list] of [["read_right", READ_RIGHT], ["ateji", ATEJI]] as const) {
        for (const [word, reading] of list) {
          const result = await judge(client, style as number, word, reading);
          if (result.asked === 0) notAsked.push(word);
          rows.push({ group, word, reading, flagged: result.flagged, engineReading: result.engineReading });
        }
      }
      const falsePositives = rows.filter((r) => r.group === "read_right" && r.flagged);
      const misses = rows.filter((r) => r.group === "ateji" && !r.flagged);
      console.log(`問わなかった語：${notAsked.join("・") || "なし"}`);
      console.log(`誤検出（読めるはずの語が出た）${falsePositives.length}/${READ_RIGHT.length}：${falsePositives.map((r) => `${r.word}→${r.engineReading}`).join("・") || "なし"}`);
      console.log(`見逃し（当て読みが出なかった）${misses.length}/${ATEJI.length}：${misses.map((r) => r.word).join("・") || "なし"}`);
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        const lines = ["組\t語\t正しい読み\t出たか\tエンジンの読み", ...rows.map((r) => [r.group, r.word, r.reading, r.flagged ? "出た" : "出ない", r.engineReading].join("\t"))];
        fs.writeFileSync(path.join(OUT, `readingKanaShapes-${new Date().toISOString().slice(0, 10)}.tsv`), `${lines.join("\n")}\n`, "utf8");
      }
    },
    30 * 60_000
  );
});
