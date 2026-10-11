import * as fs from "node:fs";
import * as nodePath from "node:path";
import { expect, test, vi } from "vitest";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import {
  combinePhotoOrient,
  parsePhotoOrient,
  photoOrientSettled,
  type PhotoOrientAnswer,
  type PhotoOrientProbe,
} from "../../src/core/photoOrientValidation";
import {
  ORIENT_PROBE_TURNS,
  PHOTO_ORIENT_NUM_CTX,
  buildPhotoOrientRequest,
} from "../../src/prompts/photoOrient";
import { LIVE_MODEL } from "./support/liveEnv";

/**
 * 写真の向きと見開きを尋ねる（P-49、設計書6.117.11）を、**手元の Ollama で実際に回す。**
 *
 * 製品と同じ依頼（`buildPhotoOrientRequest`）・同じ検算（`parsePhotoOrient`）・
 * 同じ突き合わせ（`combinePhotoOrient`。見えている向き・右へ90度・左へ90度の写しを
 * 製品と同じ順に尋ね、2つ一致したら止める）を通す。
 * 画面の canvas の縮小と回転（長辺1,024px）だけは、先に作っておいた写しで代える。
 *
 * 写しの名前は `p{番号}_r{時計回りに回した角度}.jpg`（例：p2_r090.jpg）で、
 * 1枚の写真につき r000・r090・r180・r270 の4つを置く。元の写真の正しい答えを
 * `NOVELAI_ORIENT_TRUTH` に「番号:回す角度:spread|single」をカンマでつないで渡す
 * （例：1:0:spread,2:90:single）。回した写しの正しい角度は
 * （元の角度 − 回した角度）を360で割った余り。
 *
 * **写真は作者の私的な原稿の材料。** 手元の Ollama だけへ送り、画面へは向きの答えと数だけを出す。
 *
 *   $env:NOVELAI_ORIENT_PAGES = "C:/path/to/写し"
 *   $env:NOVELAI_ORIENT_TRUTH = "1:0:spread,2:90:single,3:0:single,4:0:single"
 *   $env:NOVELAI_MODEL = "gemma4:26b"
 *   $env:NOVELAI_ORIENT_OUT = "C:/path/to/結果.txt"   # 任意。結果の表を書き出す
 *   npx vitest run --config vitest.live.config.mts test/live/photoOrient.test.ts
 */

vi.mock("../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/logger")>()),
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const pagesDir = process.env.NOVELAI_ORIENT_PAGES?.trim();
const truthRaw = process.env.NOVELAI_ORIENT_TRUTH?.trim();
const ready = !!pagesDir && !!truthRaw && fs.existsSync(pagesDir);

function readTruth(raw: string): Map<string, { rotation: number; spread: boolean }> {
  const truth = new Map<string, { rotation: number; spread: boolean }>();
  for (const item of raw.split(",")) {
    const [id, rotation, layout] = item.split(":");
    truth.set(id, { rotation: Number(rotation), spread: layout === "spread" });
  }
  return truth;
}

const turn = (degrees: number): string => String(((degrees % 360) + 360) % 360).padStart(3, "0");

test.skipIf(!ready)(
  "写真の向きと見開きを尋ね、正しい答えと比べる（NOVELAI_ORIENT_PAGES・NOVELAI_ORIENT_TRUTH を指定すると走ります）",
  async () => {
    const truth = readTruth(truthRaw as string);
    const dir = pagesDir as string;
    const files = fs
      .readdirSync(dir)
      .filter((name) => /^p\d+_r\d{3}\.jpe?g$/i.test(name))
      .sort();
    const provider = new OllamaProvider();
    const info = await provider.getModel(LIVE_MODEL);
    const numCtx = Math.min(PHOTO_ORIENT_NUM_CTX, info?.contextWindow ?? PHOTO_ORIENT_NUM_CTX);
    const rows: string[] = [
      `モデル ${LIVE_MODEL}（写真を読める申告：${String(info?.imageInput)}）num_ctx ${numCtx}`,
    ];

    // 1枚ずつの答えを先に集める（突き合わせは、同じ写真の180度違いの答えを使う）
    const answers = new Map<string, PhotoOrientAnswer | undefined>();
    const times: number[] = [];
    for (const file of files) {
      const bytes = fs.readFileSync(nodePath.join(dir, file));
      const started = Date.now();
      try {
        const result = await provider.generate({
          ...buildPhotoOrientRequest({
            image: { mimeType: "image/jpeg", base64: bytes.toString("base64") },
            model: LIVE_MODEL,
            numCtx,
          }),
          meta: { feature: "photo_orient" },
        });
        answers.set(file, parsePhotoOrient(result.text));
      } catch (error) {
        answers.set(file, undefined);
        rows.push(`${file}：失敗 ${error instanceof Error ? error.message : String(error)}`);
      }
      times.push((Date.now() - started) / 1000);
    }

    let singleHits = 0;
    let layoutHits = 0;
    let guessed = 0;
    let guessedRight = 0;
    let spreadGuessed = 0;
    let spreadRight = 0;
    let calls = 0;
    for (const file of files) {
      const match = /^p(\d+)_r(\d{3})/i.exec(file);
      if (!match) continue;
      const base = truth.get(match[1]);
      if (!base) continue;
      const shown = Number(match[2]);
      const expected = (((base.rotation - shown) % 360) + 360) % 360;
      const one = answers.get(file);
      // 製品と同じ順に尋ね、決まったところで止める（尋ねた回数も数える）
      const probes: PhotoOrientProbe[] = [];
      for (const t of ORIENT_PROBE_TURNS) {
        probes.push({ turn: t, answer: answers.get(file.replace(/_r\d{3}/i, `_r${turn(shown + t)}`)) });
        if (photoOrientSettled(probes)) break;
      }
      calls += probes.length;
      const guess = combinePhotoOrient(probes);
      if (one?.rotation === expected) singleHits += 1;
      if (one?.spread === base.spread) layoutHits += 1;
      let verdict = "推さない";
      if (guess) {
        guessed += 1;
        const ok = guess.rotation === expected;
        if (ok) guessedRight += 1;
        verdict = `推し ${guess.rotation}${ok ? "○" : "×"}`;
        if (guess.spread !== undefined) {
          spreadGuessed += 1;
          if (guess.spread === base.spread) spreadRight += 1;
          verdict += `・${guess.spread ? "見開き" : "1ページ"}${guess.spread === base.spread ? "○" : "×"}`;
        } else {
          verdict += "・見開きは推さない";
        }
      }
      rows.push(
        `${file}：1回の答え ${one ? `${one.rotation}・${one.spread ? "見開き" : "1ページ"}` : "読めず"}` +
          `（正 ${expected}・${base.spread ? "見開き" : "1ページ"}）→ ${verdict}`
      );
    }
    const steady = times.slice(1);
    rows.push(
      `1回の答え：向き ${singleHits}/${files.length}・見開き ${layoutHits}/${files.length}`,
      `突き合わせ：推した ${guessed}/${files.length}（向きが正しい ${guessedRight}・違う ${guessed - guessedRight}）・` +
        `見開きを推した ${spreadGuessed}（正しい ${spreadRight}）・尋ねた回数 計${calls}（1枚あたり平均 ${(calls / Math.max(1, files.length)).toFixed(1)}）`,
      `時間：1回目 ${times[0]?.toFixed(1)}秒（読み込み込み）・2回目以降の1回の中央値 ${median(steady).toFixed(1)}秒・最長 ${Math.max(0, ...steady).toFixed(1)}秒`
    );
    const out = process.env.NOVELAI_ORIENT_OUT?.trim();
    if (out) fs.writeFileSync(out, rows.join("\n"));
    console.log(rows.join("\n"));
    expect(files.length).toBeGreaterThan(0);
  },
  60 * 60 * 1000
);

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
