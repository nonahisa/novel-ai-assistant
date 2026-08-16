import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  LIGHT_CATEGORIES,
} from "../../src/prompts/contradictionCheck";
import {
  parseContradictionResult,
  sortContradictions,
  validateContradictions,
} from "../../src/core/contradictionValidation";
import { splitIntoChunks, withLineNumbers } from "../../src/core/chunker";

/**
 * 矛盾検知を実データで測る。
 *
 * **単体テストでは品質が測れない。** この機能は「誤検出がどれだけ出るか」が
 * 使えるかどうかを決めるので、実際の作品と実際のOllamaで走らせる。
 *
 *   npx vitest run --config vitest.ollama.config.ts test/ollama/contradictionQuality.test.ts
 */
const WORK = "C:/Users/nonah/Documents/いじめられっ子";
const MODEL = process.env.NOVELAI_MODEL ?? "gemma4:e4b";
const ENDPOINT = "http://localhost:11434";

interface CharacterJson {
  name: string;
  aliases?: string[];
  isMob?: boolean;
  firstPerson?: { default?: string | null };
  role?: string | null;
  personality?: string | null;
  appearance?: string | null;
  summary?: string | null;
}

function readJsonDir(dir: string): CharacterJson[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")));
}

/** 人物の設定を、`settingsSummary` に近い形で1件ぶん書き出す */
function describePerson(character: CharacterJson): string {
  const lines = [character.name];
  if (character.aliases?.length) lines.push(`- 別名: ${character.aliases.join("、")}`);
  if (character.firstPerson?.default) {
    lines.push(`- 一人称: ${character.firstPerson.default}`);
  }
  for (const [label, value] of [
    ["役割", character.role],
    ["性格", character.personality],
    ["外見", character.appearance],
    ["紹介", character.summary],
  ] as const) {
    if (value) lines.push(`- ${label}: ${value}`);
  }
  return lines.join("\n");
}

async function ask(prompt: string): Promise<string> {
  const response = await fetch(`${ENDPOINT}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      format: CONTRADICTION_CHECK_SCHEMA,
      options: { temperature: 0.0, num_ctx: 32768 },
      messages: [
        { role: "system", content: CONTRADICTION_CHECK_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = (await response.json()) as { message?: { content?: string } };
  return body.message?.content ?? "";
}

describe("矛盾検知の品質（実データ）", () => {
  test(
    "指摘の量と中身を測る",
    async () => {
      const characters = readJsonDir(path.join(WORK, "設定", "characters"))
        .filter((character) => !character.isMob);
      expect(characters.length, "人物設定が読めない").toBeGreaterThan(0);

      const worldview = readJsonDir(path.join(WORK, "設定", "world"))
        .map((item) => JSON.stringify(item))
        .slice(0, 5)
        .join("\n");

      const episodes = fs
        .readdirSync(WORK)
        .filter((name) => name.startsWith("episode_") && name.endsWith(".txt"))
        .sort();

      const report: string[] = [];
      let raised = 0;
      let rejected = 0;
      const rejectReasons = new Map<string, number>();
      const accepted: ReturnType<typeof validateContradictions>["accepted"] = [];

      // 全話は時間がかかる。冒頭・中盤・終盤から3話だけ見る
      const sample = [episodes[0], episodes[8], episodes[episodes.length - 1]];

      for (const fileName of sample) {
        const filePath = path.join(WORK, fileName);
        const text = fs.readFileSync(filePath, "utf-8");
        const chunks = splitIntoChunks(filePath, text, null, null, {
          maxChars: 4000,
        });

        for (const chunk of chunks) {
          // 本文に名前が出てくる人物だけを渡す（本番と同じ絞り方）
          const present = characters.filter((character) =>
            [character.name, ...(character.aliases ?? [])].some(
              (name) => name && chunk.text.includes(name)
            )
          );
          if (present.length === 0) continue;

          const prompt = buildContradictionCheckPrompt({
            chapterLabel: fileName,
            chunkTextWithLineNumbers: withLineNumbers(chunk),
            characterDetails: present.map(describePerson).join("\n\n"),
            locationDetails: "",
            worldviewSummary: worldview,
            previousSynopses: "",
            categories: LIGHT_CATEGORIES,
          });

          const raw = await ask(prompt);
          const parsed = parseContradictionResult(raw);
          if (!parsed) {
            report.push(`【読めず】${fileName} #${chunk.index}: ${raw.slice(0, 120)}`);
            continue;
          }
          raised += parsed.contradictions.length;

          const validated = validateContradictions(parsed, chunk);
          rejected += validated.rejected.length;
          for (const item of validated.rejected) {
            rejectReasons.set(
              item.reason,
              (rejectReasons.get(item.reason) ?? 0) + 1
            );
          }
          accepted.push(...validated.accepted);
        }
      }

      console.log(`\n=== モデル: ${MODEL} / ${sample.join(", ")} ===`);
      console.log(`AIが挙げた: ${raised}件`);
      console.log(`弾いた: ${rejected}件`);
      for (const [reason, count] of rejectReasons) {
        console.log(`  ${reason}: ${count}件`);
      }
      console.log(`残った: ${accepted.length}件\n`);

      for (const item of sortContradictions(accepted)) {
        console.log(
          `[${item.confidence}/${item.severity}] ${item.category} ${item.line}行\n` +
            `  引用: ${item.excerpt}\n` +
            `  設定: ${item.settingSays}\n` +
            `  本文: ${item.textSays}\n` +
            (item.note ? `  補足: ${item.note}\n` : "")
        );
      }
      for (const line of report) console.log(line);

      // 数は環境で変わるので固定しない。**目で見るための試験である**
      expect(true).toBe(true);
    },
    20 * 60 * 1000
  );
});
