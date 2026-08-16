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
  validateContradictions,
} from "../../src/core/contradictionValidation";
import { splitIntoChunks, withLineNumbers } from "../../src/core/chunker";

/**
 * 矛盾検知の**見逃し**を測る。
 *
 * 品質の試験（`contradictionQuality.test.ts`）は「余計な指摘が出ないか」しか
 * 見ていない。**何も指摘しなければ、それだけで満点になってしまう。**
 * ここでは**答えの分かっている矛盾を本文へ仕込み**、拾えるかを見る。
 *
 *   npx vitest run --config vitest.live.config.mts test/live/contradictionRecall.test.ts
 */
const WORK = "C:/Users/nonah/Documents/いじめられっ子";
const MODEL = process.env.NOVELAI_MODEL ?? "gemma4:e4b";
const ENDPOINT = "http://localhost:11434";

/** 仕込む矛盾。設定と明らかに食い違う1文を本文の末尾へ足す */
const PLANTED = [
  {
    name: "一人称",
    setting: "太志\n- 一人称: 僕\n- 役割: 主人公",
    sentence: "「拙者が行くでござる」と太志は言った。",
    mustMention: "太志",
  },
  {
    name: "外見",
    setting: "太志\n- 一人称: 僕\n- 外見: 黒髪の少年",
    sentence: "太志の金髪が朝日に光っていた。",
    mustMention: "太志",
  },
  {
    name: "状態",
    setting: "太志\n- 一人称: 僕\n- 状態: 第1話で死亡し、幽霊になっている",
    sentence: "太志は温かい味噌汁を口に運び、生きている実感を噛みしめた。",
    mustMention: "太志",
  },
];

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

describe("仕込んだ矛盾を拾えるか", () => {
  test(
    "設定と食い違う1文を見つける",
    async () => {
      const source = fs.readFileSync(
        path.join(WORK, "episode_0009.txt"),
        "utf-8"
      );
      // 長すぎると探す範囲が広がる。冒頭だけを使う
      const base = source.slice(0, 1500);

      let found = 0;
      for (const planted of PLANTED) {
        const text = `${base}\n\n${planted.sentence}\n`;
        const chunk = splitIntoChunks("C:/w/test.txt", text, 9, 9, {
          maxChars: 8000,
        })[0];

        const raw = await ask(
          buildContradictionCheckPrompt({
            chapterLabel: "第9話",
            chunkTextWithLineNumbers: withLineNumbers(chunk),
            characterDetails: planted.setting,
            locationDetails: "",
            worldviewSummary: "",
            previousSynopses: "",
            categories: LIGHT_CATEGORIES,
          })
        );

        const parsed = parseContradictionResult(raw);
        const accepted = parsed
          ? validateContradictions(parsed, chunk).accepted
          : [];
        // 仕込んだ文を指しているか。他の場所を指したものは当たりではない
        const hit = accepted.some((item) =>
          planted.sentence.includes(item.excerpt.slice(0, 8))
        );
        if (hit) found++;

        console.log(
          `\n【${planted.name}】仕込み: ${planted.sentence}\n` +
            `  当たり: ${hit ? "○" : "×"} / 指摘 ${accepted.length}件`
        );
        for (const item of accepted) {
          console.log(
            `    [${item.confidence}] ${item.category}: ${item.excerpt}\n` +
              `      設定「${item.settingSays}」／本文「${item.textSays}」` +
              (item.note ? `\n      補足: ${item.note}` : "")
          );
        }
      }

      console.log(`\n=== ${MODEL}: ${found}/${PLANTED.length} 件を検出 ===\n`);
      expect(true).toBe(true);
    },
    20 * 60 * 1000
  );
});
