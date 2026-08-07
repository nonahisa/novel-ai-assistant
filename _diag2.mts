import * as fs from "node:fs/promises";
import { parseEpisodeMetadata } from "./src/core/metadataParser.ts";
import { decideChunkSize, splitIntoChunks } from "./src/core/chunker.ts";
import {
  parseResult,
  validateCharacterExtractResult,
} from "./src/core/characterExtractionValidation.ts";
import { buildKnownCharacterNames } from "./src/features/extractCharacters.ts";
import {
  BASE_SYSTEM_PROMPT,
  CHARACTER_EXTRACT_SCHEMA,
  buildCharacterExtractPrompt,
} from "./src/prompts/characterExtract.ts";

async function main() {
  const raw = await fs.readFile(process.env.TXT!);
  const text = new TextDecoder("utf-8").decode(raw).replace(/\r\n?/g, "\n");
  const meta = parseEpisodeMetadata(text);
  const chunks = splitIntoChunks("N2600GO.txt", meta.body, null, null, {
    maxChars: decideChunkSize(131072),
  });
  console.log(`チャンク数: ${chunks.length} / chapterStart: ${chunks[0].chapterStart}`);

  const accepted: any[] = [];
  for (const chunk of chunks.slice(0, 3)) {
    const known = buildKnownCharacterNames([], accepted);
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma4:e4b", stream: false,
        messages: [
          { role: "system", content: BASE_SYSTEM_PROMPT },
          { role: "user", content: buildCharacterExtractPrompt({
              chunkText: chunk.text, chapterLabel: "本文",
              knownCharacterNames: known.slice(0, 100),
            }) },
        ],
        options: { temperature: 0.2, num_ctx: 16384 },
        format: CHARACTER_EXTRACT_SCHEMA, think: false,
      }),
    }).then((r) => r.json());

    const parsed = parseResult(res.message?.content ?? "");
    if (!parsed) { console.log("  JSON解析失敗"); continue; }
    const v = validateCharacterExtractResult(parsed, chunk);
    accepted.push(...v.accepted);
    console.log(`\n--- chunk ${chunk.index} (${chunk.text.length}字) 既知名 ${known.length}件 ---`);
    console.log(`  採用 ${v.accepted.length} / 除外 ${v.rejected.length}`);
    for (const r of v.rejected.slice(0, 6)) {
      const c = (parsed.characters ?? []).find((x: any) => x.name === r.name);
      console.log(`   ✗ ${r.name} [${r.reason}] evidence=${JSON.stringify(c?.evidence ?? null).slice(0,90)}`);
      if (c?.evidence && r.reason === "ungrounded") {
        console.log(`      名前が本文にある: ${chunk.text.includes(r.name ?? "")}`);
        console.log(`      引用が本文にある: ${chunk.text.includes(String(c.evidence))}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
