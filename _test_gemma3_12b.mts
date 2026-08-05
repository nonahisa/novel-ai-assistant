// gemma3:12b との比較用の使い捨てスクリプト。実行後は削除する。
// 設定/characters は上書きせず、比較結果は別ファイルに書き出す。
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseEpisodeFileName } from "./src/core/episodeParser.ts";
import { parseEpisodeMetadata } from "./src/core/metadataParser.ts";
import { decideChunkSize, splitIntoChunks } from "./src/core/chunker.ts";
import { mergeExtractedCharacters } from "./src/core/characterMerge.ts";
import { collect, parseResult, INVALID_NAME_PATTERN } from "./src/features/extractCharacters.ts";
import {
  BASE_SYSTEM_PROMPT,
  CHARACTER_EXTRACT_SCHEMA,
  buildCharacterExtractPrompt,
} from "./src/prompts/characterExtract.ts";

const WORK_DIR = "C:\\Users\\nonah\\Documents\\こちら冒険者ギルド生活保護課!!";
const MODEL = "gemma3:12b";
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
  console.log(`モデル: ${MODEL} / 総チャンク数: ${chunks.length}`);

  const numCtx = Math.min(CONTEXT_WINDOW, 16384);
  const extractedAll: Array<{ data: any; chapters: number[] }> = [];
  const timings: number[] = [];
  let failCount = 0;

  for (const chunk of chunks) {
    const label = describeChunk(chunk);
    const knownNames = [...new Set(extractedAll.map((e) => e.data.name))].slice(0, 100);

    const userPrompt = buildCharacterExtractPrompt({
      chunkText: chunk.text,
      chapterLabel: label,
      knownCharacterNames: knownNames,
    });

    const started = Date.now();
    try {
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
      }, 240000);
      const elapsed = Date.now() - started;
      timings.push(elapsed);

      const text = res.message?.content ?? "";
      const parsed = parseResult(text);
      if (!parsed) {
        failCount++;
        console.log(`  [失敗] ${label} (${elapsed}ms) — JSON解析失敗`);
        continue;
      }
      const before = extractedAll.length;
      collect(extractedAll, parsed, chunk);
      const added = extractedAll.length - before;
      console.log(`  [完了] ${label} (${elapsed}ms) — 人物 ${added} 件`);
    } catch (e: any) {
      failCount++;
      console.log(`  [エラー] ${label} — ${e?.message ?? e}`);
    }
  }

  const merged = mergeExtractedCharacters([], extractedAll);
  const addedSet = new Set(merged.added);
  const needsApproval = merged.characters.filter(
    (c) => addedSet.has(c.name) && INVALID_NAME_PATTERN.test(c.name)
  );

  const totalMs = timings.reduce((s, t) => s + t, 0);
  console.log(`\n=== ${MODEL} 結果サマリ ===`);
  console.log(`人物数: ${merged.characters.length} / 新規: ${merged.added.length} / 更新: ${merged.updated.length} / 要確認: ${merged.conflicts.length} / 失敗チャンク: ${failCount}`);
  console.log(`承認対象（自称・代名詞）: ${needsApproval.length}件 [${needsApproval.map(c=>c.name).join(", ")}]`);
  console.log(`所要時間合計: ${(totalMs / 1000).toFixed(1)}秒 / 平均: ${Math.round(totalMs / timings.length)}ms`);

  console.log("\n人物名一覧（role / aliases付き）:");
  for (const c of merged.characters) {
    console.log(`  - ${c.name}  role=${c.role ?? "null"}  aliases=[${c.aliases.join(", ")}]`);
  }

  // 比較用に別ファイルへ保存（設定/characters は上書きしない）
  const outFile = path.join(WORK_DIR, ".aiwriter", "compare_gemma3_12b.json");
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(merged.characters, null, 2), "utf8");
  console.log(`\n比較用データ保存先: ${outFile}`);
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
