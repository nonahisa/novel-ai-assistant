// 能力ノイズの除外が実データで効くか確認する。実行後は削除する。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseEpisodeFileName } from "./src/core/episodeParser.ts";
import { parseEpisodeMetadata } from "./src/core/metadataParser.ts";
import { decideChunkSize, splitIntoChunks } from "./src/core/chunker.ts";
import { parseResult } from "./src/core/characterExtractionValidation.ts";
import {
  normalizeExtractedAbilitySystem,
  validateExtractedAbilities,
  validateExtractedLocations,
} from "./src/core/settingsExtractionValidation.ts";
import {
  BASE_SYSTEM_PROMPT,
  CHARACTER_EXTRACT_SCHEMA,
  buildCharacterExtractPrompt,
} from "./src/prompts/characterExtract.ts";

const WORK_DIR = "C:/Users/nonah/Documents/教科書チート";
const OLLAMA = "http://localhost:11434";

async function main() {
  const entries = (await fs.readdir(WORK_DIR, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.txt$/i.test(e.name));
  const chunks: any[] = [];
  for (const e of entries) {
    const raw = await fs.readFile(path.join(WORK_DIR, e.name));
    const text = new TextDecoder("utf-8").decode(raw).replace(/\r\n?/g, "\n");
    const meta = parseEpisodeMetadata(text);
    if (!meta.body.trim()) continue;
    const p = parseEpisodeFileName(e.name);
    chunks.push(...splitIntoChunks(path.join(WORK_DIR, e.name), meta.body, p.chapterStart, p.chapterEnd, { maxChars: decideChunkSize(131072) }));
  }
  chunks.sort((a, b) => (a.chapterStart ?? 999) - (b.chapterStart ?? 999));

  const abilities = new Set<string>(), locations = new Set<string>();
  const rejected: Record<string, string[]> = {};
  let abilityTerm: string | null = null;

  for (const chunk of chunks.slice(0, Number(process.env.LIMIT ?? 8))) {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma4:e4b", stream: false,
        messages: [
          { role: "system", content: BASE_SYSTEM_PROMPT },
          { role: "user", content: buildCharacterExtractPrompt({
              chunkText: chunk.text, chapterLabel: `第${chunk.chapterStart}話`,
              knownCharacterNames: [], knownAbilityNames: [...abilities],
              knownLocationNames: [...locations],
              abilityTerm: abilityTerm ?? undefined,
            }) },
        ],
        options: { temperature: 0.2, num_ctx: 16384 },
        format: CHARACTER_EXTRACT_SCHEMA, think: false,
      }),
    }).then((r) => r.json());

    const parsed = parseResult(res.message?.content ?? "");
    if (!parsed) continue;
    const sys = normalizeExtractedAbilitySystem((parsed as any).abilitySystem);
    if (sys?.abilityTerm && !abilityTerm) abilityTerm = sys.abilityTerm;

    const a = validateExtractedAbilities((parsed as any).abilities, chunk, abilityTerm);
    for (const x of a.accepted) abilities.add(x.data.name);
    const l = validateExtractedLocations((parsed as any).locations, chunk);
    for (const x of l.accepted) locations.add(x.data.name);
    for (const r of [...a.rejected, ...l.rejected]) (rejected[r.reason] ??= []).push(r.name ?? "(名前なし)");
  }

  console.log(`総称: ${abilityTerm ?? "（読み取れず）"}`);
  console.log(`\n=== 能力 ${abilities.size}件 ===`);
  for (const n of abilities) console.log(`  - ${n}`);
  console.log(`\n=== 場所 ${locations.size}件 ===`);
  for (const n of locations) console.log(`  - ${n}`);
  console.log("\n=== 除外 ===");
  for (const [k, v] of Object.entries(rejected)) console.log(`  ${k} (${v.length}件): ${[...new Set(v)].join(", ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
