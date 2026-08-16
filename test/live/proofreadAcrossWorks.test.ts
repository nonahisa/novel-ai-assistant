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
import { decodeByteFallback } from "../../src/core/byteFallback";
import { LIVE_MODEL, OLLAMA_ENDPOINT } from "./support/liveEnv";

/**
 * 推敲を、**複数の作品**で測る。
 *
 * 1作品だけで測ったときは、
 *
 * - `冗長` の指摘が1件も出ず、**適用の道が通っていなかった**
 * - `長文` が0件で、`hasLongSentence` が本当に働くか分からなかった
 *   （その作品は短文が多く、80字超かつ読点5個以上の文が無かった）
 *
 * **作風の違う作品を並べないと、どの検査が効いているか分からない。**
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"
 *   npx vitest run --config vitest.live.config.mts test/live/proofreadAcrossWorks.test.ts
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();
/** 結果の置き場。指定が無ければ作業フォルダーへ */
const REPORT_PATH =
  process.env.NOVELAI_REPORT?.trim() ?? "proofread-across-works.txt";

function worksIn(root: string): Array<{ name: string; files: string[] }> {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "backups")
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".txt") && !name.startsWith("about"))
        .sort()
        .map((name) => path.join(dir, name));
      return { name: entry.name, files };
    })
    .filter((work) => work.files.length > 0);
}

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
  // **プロバイダと同じ手当てを通す。** ここを省くと、gemma系が全角スペースを
  // `<0xE3><0x80><0x80>` と返す癖がそのまま測定結果に出て、
  // 製品の不具合と見分けがつかなくなる（2026-08-17に一度そう見えた）
  return decodeByteFallback(body.message?.content ?? "");
}

describe.skipIf(!ROOT)(
  `推敲を複数の作品で測る${ROOT ? "" : "（NOVELAI_WORKS を指定すると走ります）"}`,
  () => {
    test(
      "作風の違う作品で、どの検査が効くか",
      async () => {
        const works = worksIn(ROOT!);
        expect(works.length, "作品が読めない").toBeGreaterThan(1);

        const byReason = new Map<string, number>();
        const byReject = new Map<string, number>();
        let raised = 0;
        let chars = 0;
        let withFix = 0;
        let looked = 0;
        const samples: string[] = [];
        const seenWorks: string[] = [];

        for (const work of works) {
          let inWork = 0;
          // 1作品につき2ファイルまで。全部見ると時間がかかりすぎる
          for (const filePath of work.files.slice(0, 2)) {
            const text = fs.readFileSync(filePath, "utf-8");
            // 1ファイルにつき先頭の1チャンクだけ
            const chunk = splitIntoChunks(filePath, text, null, null, {
              maxChars: 4000,
            })[0];
            if (!chunk || chunk.text.length < 200) continue;
            chars += chunk.text.length;
            looked++;
            inWork++;

            const raw = await ask(
              buildProofreadPrompt({
                chunkTextWithLineNumbers: withLineNumbers(chunk),
                narrativeStyle: "",
                maxIssues: issueBudget(chunk.text.length),
              })
            );
            const parsed = parseProofreadResult(raw);
            if (!parsed) continue;
            raised += parsed.issues.length;

            const validated = validateProofreadIssues(parsed, chunk);
            for (const entry of validated.rejected) {
              byReject.set(
                entry.reason,
                (byReject.get(entry.reason) ?? 0) + 1
              );
            }
            for (const item of validated.accepted) {
              byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
              if (item.suggestion) withFix++;
              samples.push(
                `[${item.confidence}] ${item.reason} ${work.name} / ` +
                  `${path.basename(filePath)} ${item.line}行\n` +
                  `  原文: ${item.original.slice(0, 60)}\n` +
                  `  提案: ${item.suggestion || "（作者が決める）"}\n` +
                  `  理由: ${item.explanation}`
              );
            }
          }
          seenWorks.push(
            `  ${work.name}: ${work.files.length}ファイル中 ${inWork}チャンクを見た`
          );
        }

        const kept = [...byReason.values()].reduce((a, b) => a + b, 0);
        const report = [
          `=== 推敲（${LIVE_MODEL}） / ${works.length}作品 / ` +
            `${chars.toLocaleString("ja-JP")}字 / ${looked}チャンク ===`,
          `AIが挙げた: ${raised}件`,
          `残った: ${kept}件（1000字あたり ` +
            `${chars > 0 ? ((kept / chars) * 1000).toFixed(1) : 0}件）`,
          `うち修正案あり: ${withFix}件`,
          "",
          "見た作品:",
          ...seenWorks,
          "",
          "種類ごと:",
          ...[...byReason].map(([reason, n]) => `  ${reason}: ${n}件`),
          "弾いた理由:",
          ...[...byReject].map(([reason, n]) => `  ${reason}: ${n}件`),
          "",
          ...samples,
        ].join("\n");
        // **console.log は vitest に捨てられる。** ファイルへ残す
        fs.writeFileSync(REPORT_PATH, report, "utf-8");
        console.log(report);

        expect(true).toBe(true);
      },
      40 * 60 * 1000
    );
  }
);
