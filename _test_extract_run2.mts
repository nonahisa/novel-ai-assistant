// プロンプト修正（一人称・自称をnameにしない）の効果を実データで再検証する
// 使い捨てスクリプト。実行後は削除する。
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseEpisodeFileName } from "./src/core/episodeParser.ts";
import { parseEpisodeMetadata } from "./src/core/metadataParser.ts";
import { decideChunkSize, splitIntoChunks } from "./src/core/chunker.ts";
import { mergeExtractedCharacters } from "./src/core/characterMerge.ts";
import { characterFileName } from "./src/models/character.ts";
import { collect, parseResult } from "./src/features/extractCharacters.ts";
import {
  BASE_SYSTEM_PROMPT,
  CHARACTER_EXTRACT_SCHEMA,
  buildCharacterExtractPrompt,
} from "./src/prompts/characterExtract.ts";

const WORK_DIR = "C:\\Users\\nonah\\Documents\\こちら冒険者ギルド生活保護課!!";
const MODEL = "gemma4:e4b";
const CONTEXT_WINDOW = 131072;
const OLLAMA_ENDPOINT = "http://localhost:11434";

async function main() {
  const chunkChars = decideChunkSize(CONTEXT_WINDOW);
  const entries = (await fs.readdir(WORK_DIR, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.(txt|md)$/i.test(e.name));

  const chunks: any[] = [];
  for (const e of entries) {
    const filePath = path.join(WORK_DIR, e.name);
    const raw = await fs.readFile(filePath);
    const text = decodeBytes(raw).replace(/\r\n?/g, "\n");
    const meta = parseEpisodeMetadata(text);
    if (!meta.body.trim()) continue;
    const parsed = parseEpisodeFileName(e.name);
    chunks.push(
      ...splitIntoChunks(filePath, meta.body, parsed.chapterStart, parsed.chapterEnd, {
        maxChars: chunkChars,
      })
    );
  }
  chunks.sort((a, b) => (a.chapterStart ?? 999) - (b.chapterStart ?? 999));
  console.log(`総チャンク数: ${chunks.length}`);

  const numCtx = Math.min(CONTEXT_WINDOW, 16384);
  const extractedAll: Array<{ data: any; chapters: number[] }> = [];
  const timings: number[] = [];

  for (const chunk of chunks) {
    const label = describeChunk(chunk);
    const knownNames = [...new Set(extractedAll.map((e) => e.data.name))].slice(0, 100);

    const userPrompt = buildCharacterExtractPrompt({
      chunkText: chunk.text,
      chapterLabel: label,
      knownCharacterNames: knownNames,
    });

    const started = Date.now();
    const res = await fetchJson("/api/chat", {
      model: MODEL,
      stream: false,
      messages: [
        { role: "system", content: BASE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      options: { temperature: 0.2, num_ctx: numCtx },
      format: CHARACTER_EXTRACT_SCHEMA,
      think: false,
    }, 180000);
    const elapsed = Date.now() - started;
    timings.push(elapsed);

    const text = res.message?.content ?? "";
    const parsed = parseResult(text);
    if (!parsed) {
      console.log(`  [失敗] ${label} (${elapsed}ms) — JSON解析失敗`);
      continue;
    }

    const before = extractedAll.length;
    collect(extractedAll, parsed, chunk);
    const added = extractedAll.length - before;
    console.log(`  [完了] ${label} (${elapsed}ms) — 人物 ${added} 件`);
  }

  const merged = mergeExtractedCharacters([], extractedAll);
  console.log(
    `\nマージ後: 登場人物 ${merged.characters.length} 名 / 新規 ${merged.added.length} / 更新 ${merged.updated.length} / 要確認 ${merged.conflicts.length}`
  );

  const outDir = path.join(WORK_DIR, "設定", "characters");
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  for (const c of merged.characters) {
    const fileName = characterFileName(c);
    const body = JSON.stringify({ ...c, updatedAt: new Date().toISOString() }, null, 2);
    await fs.writeFile(path.join(outDir, fileName), body + "\n", "utf8");
  }

  const totalMs = timings.reduce((s, t) => s + t, 0);
  console.log(`\n所要時間合計: ${(totalMs / 1000).toFixed(1)}秒`);
  console.log("\n生成された人物名一覧:");
  for (const c of merged.characters) {
    console.log(`  - ${c.name}  (aliases: ${c.aliases.join(", ") || "なし"})`);
  }
}

function decodeBytes(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

function describeChunk(chunk: { filePath: string; index: number; chapterStart: number | null; chapterEnd: number | null }): string {
  const name = path.basename(chunk.filePath);
  if (chunk.chapterStart === null) return name;
  const ch =
    chunk.chapterEnd !== null && chunk.chapterEnd !== chunk.chapterStart
      ? `第${chunk.chapterStart}〜${chunk.chapterEnd}話`
      : `第${chunk.chapterStart}話`;
  return chunk.index > 0 ? `${ch}(${chunk.index + 1})` : ch;
}

async function fetchJson(p: string, body?: unknown, timeoutMs = 8000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_ENDPOINT}${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
