import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseEpisodeMetadata } from "./src/core/metadataParser.ts";
import { decideChunkSize, splitIntoChunks } from "./src/core/chunker.ts";
import { parseResult } from "./src/core/characterExtractionValidation.ts";
import { BASE_SYSTEM_PROMPT, CHARACTER_EXTRACT_SCHEMA, buildCharacterExtractPrompt } from "./src/prompts/characterExtract.ts";

const WORK_DIR = "C:/Users/nonah/Documents/教科書チート";
async function main() {
  const files = (await fs.readdir(WORK_DIR)).filter((f) => f.endsWith(".txt"));
  const raw = await fs.readFile(path.join(WORK_DIR, files[0]));
  const text = new TextDecoder("utf-8").decode(raw).replace(/\r\n?/g, "\n");
  const meta = parseEpisodeMetadata(text);
  const chunks = splitIntoChunks(files[0], meta.body, 1, 1, { maxChars: decideChunkSize(131072) });

  for (const chunk of chunks.slice(2, 5)) {
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma4:e4b", stream: false,
        messages: [
          { role: "system", content: BASE_SYSTEM_PROMPT },
          { role: "user", content: buildCharacterExtractPrompt({ chunkText: chunk.text, chapterLabel: "第1話", knownCharacterNames: [] }) },
        ],
        options: { temperature: 0.2, num_ctx: 16384 },
        format: CHARACTER_EXTRACT_SCHEMA, think: false,
      }),
    }).then((r) => r.json());
    const parsed: any = parseResult(res.message?.content ?? "");
    console.log("abilitySystem:", JSON.stringify(parsed?.abilitySystem ?? null));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
