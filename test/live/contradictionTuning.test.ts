import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTRADICTION_CHECK_SCHEMA } from "../../src/prompts/contradictionCheck";
import {
  liveWorkPath,
  LIVE_MODEL,
  OLLAMA_ENDPOINT,
  SKIP_REASON,
} from "./support/liveEnv";

/**
 * プロンプトを比べる（実データ・実Ollama）。
 *
 * 最初の版は**仕込んだ明らかな矛盾を0/3しか拾えなかった**。
 * 誤検出を抑える指示を積み上げすぎて、何も言わなくなった疑いがある
 * （相談パネルで同じことが起きている。設計書6.19）。
 *
 * ここで**見逃し（recall）と誤検出（precision）を同時に測り**、
 * どの書き方が良いかを決める。
 *
 *   npx vitest run --config vitest.live.config.mts test/live/contradictionTuning.test.ts
 */

const SETTING = "太志\n- 一人称: 僕\n- 外見: 黒髪の少年\n- 状態: 第1話で死亡し、幽霊になっている";

/** 仕込む矛盾。設定と明らかに食い違う */
const PLANTED = [
  "「拙者が行くでござる」と太志は言った。",
  "太志の金髪が朝日に光っていた。",
  "太志は温かい味噌汁を口に運び、生きている実感を噛みしめた。",
];

// ── 版A：いまの実装（抑制を積み上げた形）
const SYSTEM_A = `あなたは日本語の小説の設定矛盾だけを検出する編集アシスタントです。

【絶対に守る原則】
1. **確信が持てないものは指摘しないこと。** 見逃しよりも誤検出の方が作者の作業を妨げる。
2. **作中で意図的に描かれた変化を矛盾と呼ばないこと。**
3. **未回収の伏線は矛盾ではない。**
4. **設定側が古い可能性を常に残すこと。**
5. 出力は指定されたJSON形式のみとすること。`;

function userA(text: string): string {
  return `以下の小説本文が、確立された設定と矛盾していないか検証してください。

【対象本文】（第9話）
${text}

【登場人物設定】（本文に登場する人物のみ）
${SETTING}

【検証項目】
1. 人物：一人称、口調、性格、外見、能力が設定と食い違わないか
2. 状態：既に死亡・離脱した人物が登場していないか、負傷や状態変化が引き継がれているか
3. 時系列：季節、時刻、経過日数、人物の年齢が矛盾していないか

【判断の注意】
- 作中で意図的に描かれた変化を矛盾と誤認しないこと。
- 未回収の伏線は矛盾ではありません。
- **設定側が誤っている可能性も考慮し、指摘は断定形にしないこと。**
- 上に設定が示されていない事柄については、何も指摘しないこと。

【出力形式】JSONのみ`;
}

// ── 版B：先に「やること」を書き、抑制は後ろへ回す
const SYSTEM_B = `あなたは日本語の小説の設定と本文を照らし合わせる編集アシスタントです。

【仕事】
設定に書かれている項目を1つずつ取り上げ、本文の記述と突き合わせてください。
食い違っている箇所があれば、設定の記述と本文の記述を並べて報告します。

【報告しないもの】
- 設定に書かれていない事柄（照らし合わせる相手がありません）
- 作中で意図的に描かれた変化、未回収の伏線

出力は指定されたJSON形式のみとすること。`;

function userB(text: string): string {
  return `【登場人物設定】
${SETTING}

【対象本文】（第9話）
${text}

【手順】
設定の各項目（一人称・外見・状態など）について、本文に対応する記述があるかを探し、
**設定と違っていれば報告**してください。設定に無い項目は飛ばします。

たとえば設定の一人称が「僕」で、本文にその人物が「俺」と言う場面があれば食い違いです。
設定で死亡している人物が、本文で普通に飲食していれば食い違いです。

**設定側が古い可能性があるため、断定はしません。**
「設定ではこうなっている」「本文ではこうなっている」を並べるだけにしてください。
作中で意図的に描かれた変化（成長・秘密の判明）は食い違いではありません。
判断がつかないものは confidence を low にしてください。

【出力形式】JSONのみ`;
}

const VARIANTS = [
  { name: "A（現行）", system: SYSTEM_A, user: userA },
  { name: "B（先に仕事を書く）", system: SYSTEM_B, user: userB },
];

async function ask(system: string, user: string): Promise<unknown[]> {
  const response = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LIVE_MODEL,
      stream: false,
      think: false,
      format: CONTRADICTION_CHECK_SCHEMA,
      options: { temperature: 0.0, num_ctx: 32768 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const body = (await response.json()) as { message?: { content?: string } };
  try {
    const parsed = JSON.parse(body.message?.content ?? "{}") as {
      contradictions?: unknown[];
    };
    return parsed.contradictions ?? [];
  } catch {
    return [];
  }
}

/**
 * 作者の手元の作品フォルダー。**ソースへ絶対パスを書かない。**
 * 決めていなければ、この試験は飛ばす（失敗にしない）。
 */
const WORK = liveWorkPath();
describe.skipIf(WORK === undefined)(
  `プロンプトの比較${WORK ? "" : `（飛ばしました: ${SKIP_REASON}）`}`, () => {
  test(
    "見逃しと誤検出を同時に測る",
    async () => {
      const source = fs
        .readFileSync(path.join(WORK!, "episode_0009.txt"), "utf-8")
        .slice(0, 1500);

      for (const variant of VARIANTS) {
        let hits = 0;
        const detail: string[] = [];

        // 見逃し：仕込んだ矛盾を拾えるか
        for (const sentence of PLANTED) {
          const items = await ask(
            variant.system,
            variant.user(`${source}\n\n${sentence}\n`)
          );
          const hit = items.some((item) => {
            const excerpt = (item as { excerpt?: string }).excerpt ?? "";
            return excerpt.length > 3 && sentence.includes(excerpt.slice(0, 6));
          });
          if (hit) hits++;
          detail.push(
            `    ${hit ? "○" : "×"} ${sentence.slice(0, 20)}… → ${items.length}件`
          );
        }

        // 誤検出：何も仕込まない本文で、いくつ挙げるか
        const clean = await ask(variant.system, variant.user(source));

        console.log(
          `\n=== ${variant.name} ===\n` +
            `  仕込みの検出: ${hits}/${PLANTED.length}\n` +
            detail.join("\n") +
            `\n  仕込み無しでの指摘: ${clean.length}件`
        );
        for (const item of clean) {
          const entry = item as Record<string, string>;
          console.log(
            `    [${entry.confidence}] ${entry.category}: ${entry.excerpt}\n` +
              `      設定「${entry.settingSays}」／本文「${entry.textSays}」`
          );
        }
      }

      expect(true).toBe(true);
    },
    20 * 60 * 1000
  );
});
