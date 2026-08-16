import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildTypoCheckPrompt,
  TYPO_CHECK_SCHEMA,
  TYPO_CHECK_SYSTEM_PROMPT,
} from "../../src/prompts/typoCheck";
import {
  parseTypoCheckResult,
  validateTypoIssues,
} from "../../src/core/typoCheckValidation";
import { splitIntoChunks, withLineNumbers } from "../../src/core/chunker";
import { decodeByteFallback } from "../../src/core/byteFallback";
import { LIVE_MODEL, OLLAMA_ENDPOINT } from "./support/liveEnv";

/**
 * 誤字脱字を、**設定資料がまだ無い作品**で測る。
 *
 * **これが新しい作品の実際の姿である。** 本文を書き始めた段階では
 * 人物も場所も抽出していないので、固有名詞の保護辞書は空になる。
 * P-09がいちばん危ないのはこの状態で、造語（「魔抜き」「商興会」「霊力」）を
 * 誤変換として指摘してくる恐れがある。
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"
 *   npx vitest run --config vitest.live.config.mts test/live/typoAcrossWorks.test.ts
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();
const REPORT_PATH =
  process.env.NOVELAI_REPORT?.trim() ?? "typo-across-works.txt";

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
      format: TYPO_CHECK_SCHEMA,
      // 誤字脱字は正解のある作業なので、揺らさない
      options: { temperature: 0.0, num_ctx: 32768 },
      messages: [
        { role: "system", content: TYPO_CHECK_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = (await response.json()) as { message?: { content?: string } };
  // **プロバイダと同じ手当てを通す**（迂回すると製品に無い不具合が見える）
  return decodeByteFallback(body.message?.content ?? "");
}

describe.skipIf(!ROOT)(
  `誤字脱字を、設定資料の無い作品で測る${ROOT ? "" : "（NOVELAI_WORKS を指定すると走ります）"}`,
  () => {
    test(
      "辞書が空でも、造語を誤字にしないか",
      async () => {
        const works = worksIn(ROOT!);
        expect(works.length, "作品が読めない").toBeGreaterThan(1);

        const byReject = new Map<string, number>();
        let raised = 0;
        let chars = 0;
        let looked = 0;
        const samples: string[] = [];

        for (const work of works) {
          for (const filePath of work.files.slice(0, 2)) {
            const text = fs.readFileSync(filePath, "utf-8");
            const chunk = splitIntoChunks(filePath, text, null, null, {
              maxChars: 4000,
            })[0];
            if (!chunk || chunk.text.length < 200) continue;
            chars += chunk.text.length;
            looked++;

            const raw = await ask(
              buildTypoCheckPrompt({
                chunkTextWithLineNumbers: withLineNumbers(chunk),
                // **わざと空にする。** 新しい作品ではこれが実際の姿
                properNounDictionary: [],
              })
            );
            const parsed = parseTypoCheckResult(raw);
            if (!parsed) continue;
            raised += parsed.issues.length;

            const validated = validateTypoIssues(parsed, chunk, []);
            for (const entry of validated.rejected) {
              byReject.set(entry.reason, (byReject.get(entry.reason) ?? 0) + 1);
            }
            for (const item of validated.accepted) {
              samples.push(
                `[${item.confidence}] ${work.name} / ` +
                  `${path.basename(filePath)} ${item.line}行\n` +
                  `  「${item.target}」→「${item.suggestion}」（${item.reason}）\n` +
                  `  原文: ${item.original.slice(0, 60)}`
              );
            }
          }
        }

        const report = [
          `=== 誤字脱字（${LIVE_MODEL}） / 辞書は空 / ` +
            `${works.length}作品 / ${chars.toLocaleString("ja-JP")}字 / ` +
            `${looked}チャンク ===`,
          `AIが挙げた: ${raised}件`,
          `残った: ${samples.length}件`,
          "",
          "弾いた理由:",
          ...[...byReject].map(([reason, n]) => `  ${reason}: ${n}件`),
          "",
          ...samples,
        ].join("\n");
        fs.writeFileSync(REPORT_PATH, report, "utf-8");
        console.log(report);

        expect(true).toBe(true);
      },
      40 * 60 * 1000
    );
  }
);
