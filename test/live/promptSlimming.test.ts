import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import {
  BASE_SYSTEM_PROMPT,
  CHARACTER_EXTRACT_SCHEMA,
  buildCharacterExtractPrompt,
} from "../../src/prompts/characterExtract";
import {
  parseResult,
  validateCharacterExtractResult,
} from "../../src/core/characterExtractionValidation";
import { splitIntoChunks, type Chunk } from "../../src/core/chunker";
import { decodeByteFallback } from "../../src/core/byteFallback";
import { OLLAMA_ENDPOINT } from "./support/liveEnv";

/**
 * 抽出ルールを外すと、何が起きるかを測る（作者の指示、2026-08-27）。
 *
 * 抽出プロンプトは指示が6,928字あり、**本文とほぼ同じ量**を毎回送っている。
 * その大半は「登場人物の抽出ルール」など、**8Bモデルが守らなかったことを
 * 1つずつ潰した積み重ね**である（引継ぎ書）。作者はいまClaudeを実運用で
 * 使っており、**8B向けの防具が今も要るのかは測っていない。**
 *
 * **削ってよいかは、削って測るまで分からない。** この作品は
 * 「片方だけ測ると、何も指摘しない実装が満点になる」を経験しているので、
 * **拾えた数と、弾かれた数の両方**を出す。
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"
 *   $env:NOVELAI_SLIM_CHUNKS = "3"      # 1条件あたりのチャンク数（既定3）
 *   npx vitest run --config vitest.live.config.mts test/live/promptSlimming.test.ts
 *
 * **製品のプロンプトは変えない。** ここで作る「短い版」は測るためのもので、
 * 結果を見てから製品へ入れるかを決める。
 */

const ROOT = process.env.NOVELAI_WORKS?.trim();
const REPORT_PATH =
  process.env.NOVELAI_REPORT?.trim() ?? "prompt-slimming.txt";
const CHUNKS = Number(process.env.NOVELAI_SLIM_CHUNKS ?? "3");
/** 1回の上限。指示を外すと出力が暴れて長引くため、多めに取る */
const CALL_TIMEOUT_MS = Number(process.env.NOVELAI_SLIM_TIMEOUT ?? "900000");
const MODELS = (process.env.NOVELAI_SLIM_MODELS ?? "gemma4:e4b,qwen3.8:latest")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

/**
 * 指示を落とした版を作る。
 *
 * **製品の関数から作る。** 別に書き起こすと、比べているものが
 * 「いまのプロンプト」ではなくなる。落とすのは【…ルール】の節だけで、
 * 本文・既知のもの・出力形式はそのまま残す。
 */
function slimPrompt(full: string): string {
  return full
    .split(/\n(?=【)/)
    .filter((part) => !/^【[^】]*ルール[^】]*】/.test(part))
    .join("\n");
}

interface Outcome {
  model: string;
  variant: "full" | "slim";
  /** JSONとして読めたか */
  parsed: number;
  /** 検査を通った人物 */
  accepted: number;
  /** 弾かれた候補と、その理由 */
  rejected: number;
  reasons: Record<string, number>;
  abilities: number;
  locations: number;
  organizations: number;
  /** 呼称・関係を出したか（指示を落とすと真っ先に消えると見込まれる） */
  addressTerms: number;
  relations: number;
  /** 待ちきれなかった回数。**遅いこと自体が結果である** */
  timedOut: number;
  seconds: number;
}

/**
 * Ollamaへ問い合わせる。
 *
 * **fetch を使わない。** Nodeの fetch には5分の上限が埋め込まれており
 * （undiciの headersTimeout）、外から延ばせない。指示を外した版は
 * **その5分に当たった**ので、時間切れも数えられる形にする。
 */
function callOllama(
  model: string,
  system: string,
  prompt: string
): Promise<{ text: string; seconds: number; timedOut: boolean }> {
  const started = Date.now();
  const body = JSON.stringify({
    model,
    stream: false,
    // **num_ctx を必ず明示する**（CLAUDE.md）。既定の短い窓だと入力が黙って切れる
    options: { num_ctx: 32768, temperature: 0.2 },
    think: false,
    format: CHARACTER_EXTRACT_SCHEMA,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });

  return new Promise((resolve) => {
    const url = new URL(`${OLLAMA_ENDPOINT}/api/chat`);
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (raw += chunk));
        response.on("end", () => {
          const seconds = Math.round((Date.now() - started) / 100) / 10;
          try {
            const json = JSON.parse(raw) as { message?: { content?: string } };
            resolve({ text: json.message?.content ?? "", seconds, timedOut: false });
          } catch {
            resolve({ text: "", seconds, timedOut: false });
          }
        });
      }
    );
    // 1回あたりの上限。**待てないほど遅いこと自体が結果**なので、記録して次へ
    request.setTimeout(CALL_TIMEOUT_MS, () => {
      request.destroy();
      resolve({
        text: "",
        seconds: Math.round(CALL_TIMEOUT_MS / 100) / 10,
        timedOut: true,
      });
    });
    request.on("error", () => {
      resolve({
        text: "",
        seconds: Math.round((Date.now() - started) / 100) / 10,
        timedOut: true,
      });
    });
    request.end(body);
  });
}

function readChunks(): Array<{ label: string; chunk: Chunk }> {
  const works = fs
    .readdirSync(ROOT!, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(ROOT!, entry.name));

  const out: Array<{ label: string; chunk: Chunk }> = [];
  for (const work of works) {
    const dir = fs.existsSync(path.join(work, "本文"))
      ? path.join(work, "本文")
      : work;
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".txt") || name.endsWith(".md"))
      .sort();
    if (files.length === 0) continue;

    const filePath = path.join(dir, files[0]);
    const text = decodeByteFallback(fs.readFileSync(filePath, "utf-8"));
    // 実データのチャンクの大きさに合わせる（モデルの窓から決まる値）
    const chunks = splitIntoChunks(filePath, text, null, null, {
      maxChars: 7839,
    });
    if (chunks.length === 0 || chunks[0].text.length < 200) continue;
    out.push({
      label: `${path.basename(work).slice(0, 12)}／${files[0]}`,
      chunk: chunks[0],
    });
    if (out.length >= CHUNKS) break;
  }
  return out;
}

describe.skipIf(!ROOT)("抽出ルールを外すと、どうなるか", () => {
  test(
    "モデル2つ × 指示あり／なし で比べる",
    async () => {
      const chunks = readChunks();
      expect(chunks.length, "本文が見つかりません").toBeGreaterThan(0);

      const outcomes: Outcome[] = [];
      for (const model of MODELS) {
        for (const variant of ["full", "slim"] as const) {
          const totals: Outcome = {
            model,
            variant,
            parsed: 0,
            accepted: 0,
            rejected: 0,
            reasons: {},
            abilities: 0,
            locations: 0,
            organizations: 0,
            addressTerms: 0,
            relations: 0,
            timedOut: 0,
            seconds: 0,
          };

          for (const chunk of chunks) {
            const full = buildCharacterExtractPrompt({
              chunkText: chunk.chunk.text,
              chapterLabel: chunk.label,
              knownCharacterNames: [],
            });
            const prompt = variant === "full" ? full : slimPrompt(full);
            const { text, seconds, timedOut } = await callOllama(
              model,
              BASE_SYSTEM_PROMPT,
              prompt
            );
            totals.seconds += seconds;
            if (timedOut) {
              totals.timedOut++;
              continue;
            }

            const parsed = parseResult(text);
            if (!parsed) continue;
            totals.parsed++;

            const checked = validateCharacterExtractResult(parsed, chunk.chunk);
            totals.accepted += checked.accepted.length;
            totals.rejected += checked.rejected.length;
            for (const item of checked.rejected) {
              totals.reasons[item.reason] =
                (totals.reasons[item.reason] ?? 0) + 1;
            }
            for (const person of checked.accepted) {
              const data = person.data as unknown as Record<string, unknown[]>;
              totals.addressTerms += (data.addressTerms ?? []).length;
              totals.relations += (data.relations ?? []).length;
            }
            const raw = parsed as unknown as Record<string, unknown[]>;
            totals.abilities += (raw.abilities ?? []).length;
            totals.locations += (raw.locations ?? []).length;
            totals.organizations += (raw.organizations ?? []).length;
          }
          outcomes.push(totals);
          // 走らせている間、何が済んだかを出す（黙って10分待たせない）
          console.log(
            `済: ${model} / ${variant} → 通過${totals.accepted} 弾${totals.rejected} ${totals.seconds}秒`
          );
        }
      }

      const lines = [
        `対象: ${chunks.length}チャンク（${chunks.map((c) => c.label).join(" / ")}）`,
        "",
        "| モデル | 指示 | JSON | 人物(通過) | 弾かれ | 呼称 | 関係 | 能力 | 場所 | 組織 | 時間切れ | 秒 |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
        ...outcomes.map(
          (o) =>
            `| ${o.model} | ${o.variant === "full" ? "あり" : "なし"} | ` +
            `${o.parsed}/${chunks.length} | ${o.accepted} | ${o.rejected} | ` +
            `${o.addressTerms} | ${o.relations} | ${o.abilities} | ` +
            `${o.locations} | ${o.organizations} | ${o.timedOut} | ${o.seconds} |`
        ),
        "",
        "弾かれた理由:",
        ...outcomes.map(
          (o) =>
            `  ${o.model} / ${o.variant}: ` +
            (Object.entries(o.reasons)
              .map(([reason, count]) => `${reason}=${count}`)
              .join(" ") || "（なし）")
        ),
      ];
      const report = lines.join("\n");
      fs.writeFileSync(REPORT_PATH, report, "utf8");
      console.log(report);
    },
    30 * 60_000
  );
});
