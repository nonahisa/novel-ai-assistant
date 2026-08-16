import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildDeviationCheckPrompt,
  deviationBudget,
  DEVIATION_CHECK_SCHEMA,
  DEVIATION_CHECK_SYSTEM_PROMPT,
  LIGHT_DEVIATION_TYPES,
} from "../../src/prompts/deviationCheck";
import {
  parseDeviationResult,
  validateDeviations,
} from "../../src/core/deviationValidation";
import {
  liveWorkPath,
  LIVE_MODEL,
  OLLAMA_ENDPOINT,
  SKIP_REASON,
} from "./support/liveEnv";

/**
 * プロット逸脱を実データで測る。
 *
 * **見逃しと誤検出を同時に見る。** 片方だけでは、何も指摘しない実装が
 * 満点になる（矛盾検知で実際にそうなった）。
 *
 * 実作品にはプロットが無いので、**各話あらすじから組み立てる**。
 * 実際の利用でも「本文からプロットを起こす」で作る流れなので不自然ではない。
 * **わざと数話ぶんを外して**おき、その話が逸脱として挙がるかを見る。
 *
 *   $env:NOVELAI_LIVE_WORK = "C:/path/to/作品"
 *   npx vitest run --config vitest.live.config.mts test/live/deviationQuality.test.ts
 */
interface SynopsisEntry {
  chapter: number | null;
  fileName: string;
  synopsis: string;
}

async function ask(prompt: string): Promise<string> {
  const response = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LIVE_MODEL,
      stream: false,
      think: false,
      format: DEVIATION_CHECK_SCHEMA,
      options: { temperature: 0.2, num_ctx: 32768 },
      messages: [
        { role: "system", content: DEVIATION_CHECK_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = (await response.json()) as { message?: { content?: string } };
  return body.message?.content ?? "";
}

const WORK = liveWorkPath();

describe.skipIf(WORK === undefined)(
  `プロット逸脱の品質${WORK ? "" : `（飛ばしました: ${SKIP_REASON}）`}`,
  () => {
    test(
      "プロットに載せた話・外した話で、挙がり方が変わるか",
      async () => {
        const set = JSON.parse(
          fs.readFileSync(
            path.join(WORK!, "設定", "chapter_synopses.json"),
            "utf-8"
          )
        ) as { episodes: SynopsisEntry[] };
        const episodes = set.episodes.filter((entry) => entry.chapter !== null);
        expect(episodes.length, "あらすじが読めない").toBeGreaterThan(5);

        // **わざと外す話**。ここが「プロットに無い展開」になる
        const omitted = new Set([3, 9]);
        const plot = [
          `# ${path.basename(WORK!)}`,
          "",
          "## ログライン",
          "いじめで死んだ少年が幽霊になり、周囲の力を借りて真相を明かしていく。",
          "",
          "## あらすじ",
          ...episodes
            .filter((entry) => !omitted.has(entry.chapter!))
            .map((entry) => `- 第${entry.chapter}話: ${entry.synopsis}`),
        ].join("\n");

        // 載せた話2つ・外した話2つを見る
        const sample = [1, 3, 5, 9];
        let raised = 0;
        const rejectReasons = new Map<string, number>();
        const byChapter = new Map<number, number>();
        const detail: string[] = [];

        for (const chapter of sample) {
          const entry = episodes.find((item) => item.chapter === chapter);
          if (!entry) continue;
          const text = fs
            .readFileSync(path.join(WORK!, entry.fileName), "utf-8")
            .slice(0, 6000);
          const numbered = text
            .split("\n")
            .map((line, index) => `${index + 1}: ${line}`)
            .join("\n");

          const raw = await ask(
            buildDeviationCheckPrompt({
              chapterLabel: `第${chapter}話`,
              plot,
              chapterTextWithLineNumbers: numbered,
              surroundingSynopses: episodes
                .filter(
                  (item) =>
                    item.chapter !== null &&
                    Math.abs(item.chapter - chapter) <= 2 &&
                    item.chapter !== chapter
                )
                .map((item) => `第${item.chapter}話: ${item.synopsis}`)
                .join("\n"),
              types: LIGHT_DEVIATION_TYPES,
              maxIssues: deviationBudget(text.length),
            })
          );

          const parsed = parseDeviationResult(raw);
          if (!parsed) {
            detail.push(`第${chapter}話: 応答を読み取れず`);
            continue;
          }
          raised += parsed.deviations.length;

          const validated = validateDeviations(parsed, { text, plot });
          for (const item of validated.rejected) {
            rejectReasons.set(
              item.reason,
              (rejectReasons.get(item.reason) ?? 0) + 1
            );
          }
          byChapter.set(chapter, validated.accepted.length);

          detail.push(
            `\n第${chapter}話（プロットに${omitted.has(chapter) ? "**無い**" : "ある"}）: ` +
              `AI ${parsed.deviations.length}件 → 残り ${validated.accepted.length}件`
          );
          for (const item of validated.accepted) {
            detail.push(
              `  [${item.confidence}] ${item.type} ${item.lineStart}〜${item.lineEnd}行\n` +
                `    引用: ${item.excerpt}\n` +
                `    プロット: ${item.plotReference}\n` +
                `    理由: ${item.reason}`
            );
          }
        }

        const omittedTotal = [...omitted].reduce(
          (sum, chapter) => sum + (byChapter.get(chapter) ?? 0),
          0
        );
        const includedTotal = sample
          .filter((chapter) => !omitted.has(chapter))
          .reduce((sum, chapter) => sum + (byChapter.get(chapter) ?? 0), 0);

        console.log(
          `\n=== プロット逸脱（${LIVE_MODEL}） ===\n` +
            `AIが挙げた: ${raised}件\n` +
            `プロットに**無い**話（${[...omitted].join("・")}）: ${omittedTotal}件\n` +
            `プロットに**ある**話: ${includedTotal}件`
        );
        for (const [reason, count] of rejectReasons) {
          console.log(`  弾いた ${reason}: ${count}件`);
        }
        console.log(detail.join("\n"));

        // **数は環境で変わるので固定しない。目で見るための試験である**
        expect(true).toBe(true);
      },
      30 * 60 * 1000
    );
  }
);
