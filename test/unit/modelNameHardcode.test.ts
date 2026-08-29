import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

/**
 * モデル名をコードへ散らかさない（CLAUDE.md 規則6）。
 *
 * **新しいモデルが次々出る。** 名前をあちこちに書くと、薦めるモデルを
 * 変えるときに片方だけ直る。実際に `core/requirements.ts` の
 * `RECOMMENDED_CHAT_MODEL` と `features/setupOllama.ts` の
 * `RECOMMENDED_MODEL` が**同じ値・同じコメントの写し**だった
 * （統合セットアップは新しいモデルを勧めるのに、Ollamaのセットアップは
 * 古いモデルを取りに行く、という食い違いになる。0.28.6で1つへ寄せた）。
 *
 * ここでは**実コードの文字列リテラルだけ**を見る。コメントの中の
 * 実測記録（「gemma4:e4b と gemma4:12b で5回測った」など）は残してよい
 * ——あれは判断の根拠であって、動きを決めていない。
 */

const SRC = path.join(__dirname, "..", "..", "src");

/**
 * よく出るモデルの系統。名前そのものではなく**系統**で見る。
 *
 * **単語の頭でだけ当てる**（`\b`）。付けないと `Ollama` の中の `llama` を
 * 拾ってしまい、プロバイダ名や設定キーが山ほど引っかかる。
 */
const MODEL_FAMILY =
  /\b(gemma|qwen|llama|mistral|phi-\d|gpt-[45]|claude-[34]|gemini-[12])/i;

/**
 * 名前を持ってよい場所。**増やすときは理由を書く。**
 *
 * - `core/requirements.ts`：薦めるモデルの唯一の定義
 * - `ai/*Provider.ts`：既定モデルの候補や、プロバイダ固有の言い回し
 * - `dev/`：実機確認の項目（配布物に入らない）
 */
const ALLOWED = [
  "core/requirements.ts",
  "dev/pendingCheckItems.ts",
  "views/pendingChecks.ts",
  // 「gemma4:e4b と gemma4:12b で5回測った」という**過去の事実**を、
  // 逸脱検知が効かない断り書きの根拠として示している（設計書6.10.2）。
  // 動きを決めていない——設定でも既定値でもないので、新しいモデルが
  // 出ても直す必要がない
  "features/checkDeviations.ts",
];

/** 行コメント・ブロックコメントを落として、実コードだけにする */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** その行にある文字列リテラルを取り出す */
function stringLiterals(code: string): string[] {
  return [...code.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g)].map(
    (match) => match[1] ?? match[2] ?? ""
  );
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function offenders(): string[] {
  return walk(SRC)
    .map((file) => ({ file, name: path.relative(SRC, file).replace(/\\/g, "/") }))
    .filter(({ name }) => !ALLOWED.includes(name))
    .flatMap(({ file, name }) => {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      return stringLiterals(code)
        .filter((literal) => MODEL_FAMILY.test(literal))
        .map((literal) => `${name}: ${JSON.stringify(literal)}`);
    });
}

describe("モデル名をコードへ散らかさない", () => {
  test("許可した場所のほかに、モデル名の文字列が無い", () => {
    // 落ちたら：その名前を `core/requirements.ts` から import する。
    // プロバイダ固有の事情で必要なら、理由を書いて ALLOWED に足す
    expect(offenders()).toEqual([]);
  });

  test("薦めるモデルの定義は1か所だけ", () => {
    // `RECOMMENDED_MODEL = "…"` のような**値の直書き**を数える。
    // 別名を付けて配るのは構わない（`= RECOMMENDED_CHAT_MODEL`）
    const defining = walk(SRC).filter((file) =>
      /RECOMMENDED\w*MODEL\s*(:[^=]*)?=\s*["']/.test(stripComments(fs.readFileSync(file, "utf8")))
    );
    expect(defining.map((file) => path.relative(SRC, file).replace(/\\/g, "/"))).toEqual([
      "core/requirements.ts",
    ]);
  });
});
