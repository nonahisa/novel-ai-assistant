import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildCharacterExtractPrompt,
  BASE_SYSTEM_PROMPT,
  CHARACTER_EXTRACT_SCHEMA,
} from "../../src/prompts/characterExtract";
import {
  parseResult,
  validateCharacterExtractResult,
} from "../../src/core/characterExtractionValidation";
import {
  validateExtractedAbilities,
  validateExtractedLocations,
  validateExtractedOrganizations,
} from "../../src/core/settingsExtractionValidation";
import { splitIntoChunks } from "../../src/core/chunker";
import { decodeByteFallback } from "../../src/core/byteFallback";
import { LIVE_MODEL, OLLAMA_ENDPOINT } from "./support/liveEnv";

/**
 * 人物・能力・場所・組織の抽出を、**作風の違う10作品**で測る。
 *
 * これまで抽出を測ったのは1作品だけだった。**この規模では一度も測っていない。**
 *
 * 見たいのは2つ。
 *
 * 1. **拾った名前が本当に人物か。** 地名・役職・普通名詞を人物として
 *    拾っていないか（`non_person` `collective` で弾いているはずのもの）
 * 2. **主要な人物を取りこぼしていないか。** 検査を厳しくすると、
 *    何も拾わない実装が「誤検出0件」で満点になる
 *
 * **話をまたいで積む。** 1つ目の話で拾った名前を次の話へ渡すのが本来の
 * 動きなので（`knownCharacterNames`）、そこも同じにする。
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"
 *   npx vitest run --config vitest.live.config.mts test/live/extractAcrossWorks.test.ts
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();
const REPORT_PATH =
  process.env.NOVELAI_REPORT?.trim() ?? "extract-across-works.txt";
/** 1作品あたりに見るファイル数。既定2 */
const PER_WORK = Number(process.env.NOVELAI_FILES ?? "2");
/** 拾った名前の書き出し先。誤字脱字の測定が読む */
const DICTIONARY_PATH = process.env.NOVELAI_DICTIONARY?.trim();

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
      format: CHARACTER_EXTRACT_SCHEMA,
      // 製品と同じ（extractCharacters.ts）
      options: { temperature: 0.2, num_ctx: 32768 },
      messages: [
        { role: "system", content: BASE_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = (await response.json()) as { message?: { content?: string } };
  // **プロバイダと同じ手当てを通す**（迂回すると製品に無い不具合が見える）
  return decodeByteFallback(body.message?.content ?? "");
}

/**
 * **必ず製品と同じ検証を通す。**
 *
 * 1回目の測定では `parsed.abilities` から直接名前を取り出しており、
 * 能力名に `null` が並んだ。製品は `isValidSettingName` で弾いているので、
 * **製品に無い不具合を見つけたことになっていた**（同じ迂回を1日に2度した）。
 */
function namesOf(
  validated: { accepted: Array<{ data: { name: string } }> } | null
): string[] {
  return validated ? validated.accepted.map((entry) => entry.data.name) : [];
}

describe.skipIf(!ROOT)(
  `設定資料の抽出を、作風の違う作品で測る${ROOT ? "" : "（NOVELAI_WORKS を指定すると走ります）"}`,
  () => {
    test(
      "人物・能力・場所・組織を、実データから拾えるか",
      async () => {
        const works = worksIn(ROOT!);
        expect(works.length, "作品が読めない").toBeGreaterThan(1);

        const byReject = new Map<string, number>();
        const sections: string[] = [];
        let chars = 0;
        let looked = 0;
        let people = 0;
        /** 作品名 → 拾った固有名詞 */
        const dictionary: Record<string, string[]> = {};

        for (const work of works) {
          // **話をまたいで積む。** 本来の動きに合わせる
          const known = new Set<string>();
          const abilities = new Set<string>();
          const locations = new Set<string>();
          const organizations = new Set<string>();
          const rejectedHere: string[] = [];

          for (const [index, filePath] of work.files
            .slice(0, PER_WORK)
            .entries()) {
            const text = fs.readFileSync(filePath, "utf-8");
            const chunk = splitIntoChunks(filePath, text, null, null, {
              maxChars: 4000,
            })[0];
            if (!chunk || chunk.text.length < 200) continue;
            chars += chunk.text.length;
            looked++;

            const raw = await ask(
              buildCharacterExtractPrompt({
                chunkText: chunk.text,
                chapterLabel: `第${index + 1}話`,
                knownCharacterNames: [...known],
                knownAbilityNames: [...abilities],
                knownLocationNames: [...locations],
                knownOrganizationNames: [...organizations],
              })
            );
            const parsed = parseResult(raw);
            if (!parsed) continue;

            const validated = validateCharacterExtractResult(parsed, chunk);
            for (const entry of validated.rejected) {
              byReject.set(entry.reason, (byReject.get(entry.reason) ?? 0) + 1);
              rejectedHere.push(`${entry.name ?? "（名前なし）"}（${entry.reason}）`);
            }
            for (const entry of validated.accepted) {
              // **モブは印を付けて残す設計**なので、そう分かるように出す
              known.add(
                entry.data.isMob ? `${entry.data.name}〔モブ〕` : entry.data.name
              );
            }

            // **能力・場所・組織にも、製品と同じ検証をかける**
            const ability = validateExtractedAbilities(parsed.abilities, chunk);
            const location = validateExtractedLocations(parsed.locations, chunk);
            const organization = validateExtractedOrganizations(
              parsed.organizations,
              chunk
            );
            for (const group of [ability, location, organization]) {
              for (const entry of group.rejected) {
                const key = `設定:${entry.reason}`;
                byReject.set(key, (byReject.get(key) ?? 0) + 1);
                rejectedHere.push(
                  `${entry.name ?? "（名前なし）"}（${entry.reason}）`
                );
              }
            }
            for (const name of namesOf(ability)) abilities.add(name);
            for (const name of namesOf(location)) locations.add(name);
            for (const name of namesOf(organization)) organizations.add(name);
          }

          people += known.size;
          // **モブの印は辞書へ入れない。** 本文には無い文字列である
          dictionary[work.name] = [
            ...new Set(
              [...known, ...abilities, ...locations, ...organizations].map(
                (name) => name.replace(/〔モブ〕$/u, "")
              )
            ),
          ];
          sections.push(
            [
              `## ${work.name}`,
              `  人物（${known.size}）: ${[...known].join("、") || "—"}`,
              `  能力（${abilities.size}）: ${[...abilities].join("、") || "—"}`,
              `  場所（${locations.size}）: ${[...locations].join("、") || "—"}`,
              `  組織（${organizations.size}）: ${[...organizations].join("、") || "—"}`,
              `  弾いた（${rejectedHere.length}）: ${rejectedHere.join("、") || "—"}`,
            ].join("\n")
          );
        }

        const report = [
          `=== 設定資料の抽出（${LIVE_MODEL}） / ${works.length}作品 / ` +
            `${chars.toLocaleString("ja-JP")}字 / ${looked}チャンク ===`,
          `拾った人物: 合計 ${people}人`,
          "",
          "弾いた理由:",
          ...[...byReject].map(([reason, n]) => `  ${reason}: ${n}件`),
          "",
          ...sections,
        ].join("\n");
        fs.writeFileSync(REPORT_PATH, report, "utf-8");
        console.log(report);

        // **拾った名前を辞書として書き出す。**
        // 誤字脱字の測定（typoAcrossWorks）が読み、
        // 「設定資料を先に抽出すると誤検出が減るのか」を確かめる
        if (DICTIONARY_PATH) {
          fs.writeFileSync(
            DICTIONARY_PATH,
            JSON.stringify(dictionary, null, 2),
            "utf-8"
          );
        }

        expect(true).toBe(true);
      },
      60 * 60 * 1000
    );
  }
);
