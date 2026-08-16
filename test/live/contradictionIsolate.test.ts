import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  LIGHT_CATEGORIES,
} from "../../src/prompts/contradictionCheck";
import { splitIntoChunks, withLineNumbers } from "../../src/core/chunker";

/**
 * **本物のプロンプトで**見逃しを測り直す。
 *
 * 比較用に短く書き直した版は3/3拾ったのに、本物は0/3だった。
 * 材料の違いか、プロンプトの文言の違いかを切り分ける。
 */
const WORK = "C:/Users/nonah/Documents/いじめられっ子";
const MODEL = process.env.NOVELAI_MODEL ?? "gemma4:e4b";
const ENDPOINT = "http://localhost:11434";

const FULL_SETTING =
  "太志\n- 一人称: 僕\n- 外見: 黒髪の少年\n- 状態: 第1話で死亡し、幽霊になっている";

const PLANTED = [
  { label: "一人称", sentence: "「拙者が行くでござる」と太志は言った。" },
  { label: "外見", sentence: "太志の金髪が朝日に光っていた。" },
  {
    label: "状態",
    sentence: "太志は温かい味噌汁を口に運び、生きている実感を噛みしめた。",
  },
];

async function ask(user: string): Promise<Array<Record<string, string>>> {
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
        { role: "user", content: user },
      ],
    }),
  });
  const body = (await response.json()) as { message?: { content?: string } };
  try {
    const parsed = JSON.parse(body.message?.content ?? "{}") as {
      contradictions?: Array<Record<string, string>>;
    };
    return parsed.contradictions ?? [];
  } catch {
    return [];
  }
}

describe("本物のプロンプト", () => {
  test(
    "材料を揃えて測り直す",
    async () => {
      const source = fs
        .readFileSync(path.join(WORK, "episode_0009.txt"), "utf-8")
        .slice(0, 1500);

      let hits = 0;
      for (const planted of PLANTED) {
        const text = `${source}\n\n${planted.sentence}\n`;
        const chunk = splitIntoChunks("C:/w/t.txt", text, 9, 9, {
          maxChars: 8000,
        })[0];

        const items = await ask(
          buildContradictionCheckPrompt({
            chapterLabel: "第9話",
            chunkTextWithLineNumbers: withLineNumbers(chunk),
            characterDetails: FULL_SETTING,
            locationDetails: "",
            worldviewSummary: "",
            previousSynopses: "",
            categories: LIGHT_CATEGORIES,
          })
        );

        const hit = items.some((item) => {
          const excerpt = item.excerpt ?? "";
          return excerpt.length > 3 && planted.sentence.includes(excerpt.slice(0, 6));
        });
        if (hit) hits++;
        console.log(
          `\n【${planted.label}】${hit ? "○" : "×"} 指摘${items.length}件`
        );
        for (const item of items) {
          console.log(
            `    [${item.confidence}] category=「${item.category}」\n` +
              `      引用: ${item.excerpt}\n` +
              `      設定: ${item.settingSays}\n` +
              `      本文: ${item.textSays}`
          );
        }
      }

      // 仕込み無しでの誤検出も見る
      const chunk = splitIntoChunks("C:/w/t.txt", source, 9, 9, {
        maxChars: 8000,
      })[0];
      const clean = await ask(
        buildContradictionCheckPrompt({
          chapterLabel: "第9話",
          chunkTextWithLineNumbers: withLineNumbers(chunk),
          characterDetails: FULL_SETTING,
          locationDetails: "",
          worldviewSummary: "",
          previousSynopses: "",
          categories: LIGHT_CATEGORIES,
        })
      );

      console.log(
        `\n=== 本物のプロンプト（${MODEL}）: 検出 ${hits}/${PLANTED.length} / ` +
          `仕込み無しでの指摘 ${clean.length}件 ===`
      );
      for (const item of clean) {
        console.log(
          `    [${item.confidence}] category=「${item.category}」 ${item.excerpt}\n` +
            `      設定「${item.settingSays}」／本文「${item.textSays}」`
        );
      }

      expect(true).toBe(true);
    },
    20 * 60 * 1000
  );
});
