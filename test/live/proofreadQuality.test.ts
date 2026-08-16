import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildProofreadPrompt,
  issueBudget,
  PROOFREAD_SCHEMA,
  PROOFREAD_SYSTEM_PROMPT,
} from "../../src/prompts/proofread";
import {
  parseProofreadResult,
  validateProofreadIssues,
} from "../../src/core/proofreadValidation";
import { splitIntoChunks, withLineNumbers } from "../../src/core/chunker";
import {
  liveWorkPath,
  LIVE_MODEL,
  OLLAMA_ENDPOINT,
  SKIP_REASON,
} from "./support/liveEnv";

/**
 * 推敲を実データで測る。
 *
 * **この機能は「出しすぎ」が使えるかを決める。** 誤字脱字には正解があるが
 * 推敲には無く、AIはどの文にも何かしら言える。単体テストでは測れない。
 *
 * 見るのは2つ。
 *   1. **どれだけ挙げてくるか**（1000字あたり何件か）
 *   2. **決めた4種類の外へ出ていないか**（文体への干渉が混ざらないか）
 *
 *   $env:NOVELAI_LIVE_WORK = "C:/path/to/作品"
 *   npx vitest run --config vitest.live.config.mts test/live/proofreadQuality.test.ts
 */
async function ask(prompt: string): Promise<string> {
  const response = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LIVE_MODEL,
      stream: false,
      think: false,
      format: PROOFREAD_SCHEMA,
      options: { temperature: 0.2, num_ctx: 32768 },
      messages: [
        { role: "system", content: PROOFREAD_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = (await response.json()) as { message?: { content?: string } };
  return body.message?.content ?? "";
}

const WORK = liveWorkPath();

describe.skipIf(WORK === undefined)(
  `推敲の品質${WORK ? "" : `（飛ばしました: ${SKIP_REASON}）`}`,
  () => {
    test(
      "どれだけ挙げてくるか、種類は守られるか",
      async () => {
        const episodes = fs
          .readdirSync(WORK!)
          .filter((name) => name.startsWith("episode_") && name.endsWith(".txt"))
          .sort();
        // 冒頭・中盤・終盤から3話
        const sample = [episodes[0], episodes[8], episodes[episodes.length - 1]];

        let raised = 0;
        let overBudget = 0;
        let chars = 0;
        const rejectReasons = new Map<string, number>();
        const kept: Array<{ file: string; item: unknown }> = [];

        for (const fileName of sample) {
          const filePath = path.join(WORK!, fileName);
          const text = fs.readFileSync(filePath, "utf-8");
          for (const chunk of splitIntoChunks(filePath, text, null, null, {
            maxChars: 4000,
          })) {
            chars += chunk.text.length;
            const raw = await ask(
              buildProofreadPrompt({
                chunkTextWithLineNumbers: withLineNumbers(chunk),
                narrativeStyle: "一人称（僕）",
                maxIssues: issueBudget(chunk.text.length),
              })
            );
            const parsed = parseProofreadResult(raw);
            if (!parsed) continue;
            raised += parsed.issues.length;

            const validated = validateProofreadIssues(parsed, chunk);
            for (const entry of validated.rejected) {
              rejectReasons.set(
                entry.reason,
                (rejectReasons.get(entry.reason) ?? 0) + 1
              );
              if (entry.reason === "over_budget") overBudget++;
            }
            for (const item of validated.accepted) {
              kept.push({ file: fileName, item });
            }
          }
        }

        const per1000 = (count: number) =>
          chars > 0 ? ((count / chars) * 1000).toFixed(1) : "0";

        console.log(
          `\n=== 推敲（${LIVE_MODEL}） / 本文 ${chars.toLocaleString("ja-JP")}字 ===\n` +
            `AIが挙げた: ${raised}件（1000字あたり ${per1000(raised)}件）\n` +
            `上限で絞った: ${overBudget}件\n` +
            `残った: ${kept.length}件（1000字あたり ${per1000(kept.length)}件）`
        );
        for (const [reason, count] of rejectReasons) {
          console.log(`  弾いた ${reason}: ${count}件`);
        }
        console.log("");

        for (const { file, item } of kept) {
          const entry = item as Record<string, string>;
          console.log(
            `[${entry.confidence}] ${entry.reason} ${file} ${entry.line}行\n` +
              `  原文: ${entry.original}\n` +
              `  提案: ${entry.suggestion}\n` +
              `  理由: ${entry.explanation}\n`
          );
        }

        // **1000字あたり3件を超えて残ってはいけない。** 上限の効きを見る
        expect(Number(per1000(kept.length))).toBeLessThanOrEqual(3.5);
      },
      20 * 60 * 1000
    );
  }
);
