// 測るときの `num_ctx` を、**製品と同じ道で決める**（CLAUDE.md 規則6）。
//
// ## なぜ要るか（2026-09-19）
//
// 同じ台（3話・約3,700字）で4モデルを比べたら、**VRAM に収まる小さい
// モデルのほうが遅い**という結果になった（12b 349秒、qwen3:8b 411秒に対し、
// VRAM に入らない 26b が165秒）。原因は測定台にあった——`measure.mjs` が
// `num_ctx` を 32,768 に決め打ちして全モデルへ渡しており、`/api/ps` を見ると
// qwen3:8b（4.9GB）が全体 7.56GB を占めて 1.8GB が VRAM から溢れていた。
// **製品では起きない溢れを、測定台が自分で作って測っていた。**
//
// 製品（`src/ai/ollamaProvider.ts`）は決め打ちをしない。**送るプロンプトの
// 長さから** `contextSizeForPrompt`（`src/core/chunker.ts`）で決める。
//
// ## 式を写さない
//
// ここが借りるのは**束（`dist/core-bundle.mjs`）の関数そのもの**である。
// 式をこちらへ書き写すと、製品が決め方を変えたときに**測定だけが古い
// 決め方で回り続ける**——しかも、そのことは数字からは見えない。
// 定数（出力の見込みなど）も同じ理由で、源のファイルから読む
// （`measureScoring.mjs` の `maxIssuesPer1000CharsOf` と同じやり方）。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./mcpClient.mjs";

/** 外から呼ぶ束（`npm run bundle:core` が出す）。**製品の関数はここから借りる** */
export const CORE_BUNDLE_PATH = path.join(REPO_ROOT, "dist", "core-bundle.mjs");

/** 借りる関数の源。束が古くなっていないかを見るために要る */
const CHUNKER_SOURCE = path.join(REPO_ROOT, "src", "core", "chunker.ts");
/** 出力に見込むトークン数（`OUTPUT_RESERVE_TOKENS`）の源 */
const CONTEXT_GUARD_SOURCE = path.join(REPO_ROOT, "src", "ai", "contextGuard.ts");
/** 同梱の実測に添える件数（`BUNDLED_CHARS_PER_TOKEN_SAMPLES`）の源 */
const MODEL_TUNING_SOURCE = path.join(REPO_ROOT, "src", "core", "modelTuning.ts");

/* ── 源から定数を読む ─────────────────────────────────── */

/**
 * `.ts` の源から `名前 = 数字` を読む。
 *
 * **写しを持たない。** `.mjs` からは `.ts` を import できないので、
 * `measureScoring.mjs` の `maxIssuesPer1000CharsOf()` と同じやり方で
 * 源のファイルから取り出す。**見つからなければ止める**——既定値で
 * 代わりに動くと、製品が値を変えたことに気づかないまま測り続ける。
 */
export function constantOf(source, name) {
  const pattern = new RegExp(`${name}\\s*(?::\\s*number\\s*)?=\\s*([\\d_]+)`);
  const match = pattern.exec(String(source));
  if (!match) {
    throw new Error(
      `${name} を源から読めませんでした（製品の書き方が変わったなら、測定台の読み方も直してください）。`
    );
  }
  return Number(match[1].replace(/_/g, ""));
}

/**
 * 応答に見込むトークン数。
 *
 * **製品の最後の受け皿と同じ値**（`ai/ollamaProvider.ts` は
 * `plannedOutputTokens ?? maxOutputTokens ?? OUTPUT_RESERVE_TOKENS` の順で読む）。
 * 測定台は VS Code の設定も機能ごとの実測も持たないので、**製品が
 * 「何も分からないとき」に使う値**をそのまま使う。
 */
export function outputReserveTokens() {
  return constantOf(
    fs.readFileSync(CONTEXT_GUARD_SOURCE, "utf8"),
    "OUTPUT_RESERVE_TOKENS"
  );
}

/**
 * 同梱の実測（字/トークン）に添える件数。
 *
 * 製品は台帳に無い欄を同梱の値で埋めるとき、**しきい値を満たす件数を
 * 一緒に添える**（`core/modelTuning.ts`）。添えないと安全側の
 * `resolveCharsPerToken` が実測を信じず、当て推量（0.7）のままになる。
 * 測定台も同じ数を添えないと、**製品より大きい `num_ctx` で測ることになる。**
 */
export function bundledCharsPerTokenSamples() {
  return constantOf(
    fs.readFileSync(MODEL_TUNING_SOURCE, "utf8"),
    "BUNDLED_CHARS_PER_TOKEN_SAMPLES"
  );
}

/* ── 製品の関数を借りる ───────────────────────────────── */

/**
 * `contextSizeForPrompt` を束から借りる。
 *
 * **束が無ければ止める**（`mcpClient.mjs` の `assertBundleExists` と同じ作法）。
 * ここで当て推量へ落ちると、「製品と同じ決め方で測った」という記録だけが
 * 残って、実際は別の決め方で測ったことになる。
 *
 * @returns `{ contextSizeForPrompt, stale }`。`stale` は**源のほうが束より
 *   新しい**とき（＝束ね直し忘れ）に立つ。止めはしないが、黙りもしない。
 */
export async function loadContextSizeForPrompt() {
  if (!fs.existsSync(CORE_BUNDLE_PATH)) {
    throw new Error(
      `${path.relative(REPO_ROOT, CORE_BUNDLE_PATH)} がありません。` +
        "先に npm run bundle:core を実行してください" +
        "（num_ctx の決め方を、製品の関数から借りています）。"
    );
  }
  const bundledAt = fs.statSync(CORE_BUNDLE_PATH).mtimeMs;
  const sourceAt = fs.statSync(CHUNKER_SOURCE).mtimeMs;

  const loaded = await import(pathToFileURL(CORE_BUNDLE_PATH).href);
  // 束ねる側（`scripts/bundleCore.mjs`）が付ける名前。`core/chunker.ts` → `core$chunker`
  const borrowed = loaded.core$chunker?.contextSizeForPrompt;
  if (typeof borrowed !== "function") {
    throw new Error(
      "束に contextSizeForPrompt がありません（npm run bundle:core で束ね直してください）。"
    );
  }
  return { contextSizeForPrompt: borrowed, stale: sourceAt > bundledAt };
}

/* ── 何字のプロンプトを送るのか ───────────────────────── */

/**
 * `novel.prompt` の返事から、**いちばん長いプロンプトの字数**を出す。
 *
 * **チャンクごとに `num_ctx` を変えない。** Ollama は `num_ctx` が変わると
 * モデルを読み込み直すので、チャンクごとに最適な値を送ると**チャンクの数だけ
 * 読み込み直す**（設計書6.53。作者の「抽出中にコンソールが何度も出る」は
 * これだった）。いちばん長いチャンクに合わせて1つに決める。
 *
 * **チャンクを返さない道具（作品ぜんたいを1回で見るもの）にも効く**
 * ——そちらは `userPrompt` が返事の直下にある。
 */
export function promptCharsOf(response) {
  const system = String(response?.systemPrompt ?? "").length;
  const chunks = Array.isArray(response?.chunks) ? response.chunks : [];
  let longest = 0;
  for (const chunk of chunks) {
    longest = Math.max(longest, String(chunk?.userPrompt ?? "").length);
  }
  if (chunks.length === 0) {
    longest = String(response?.userPrompt ?? "").length;
  }
  const total = system + longest;
  // **0 を返さない。** 「送る量が分からなかった」と「0字だった」は別のこと
  return total > 0 ? total : null;
}

/**
 * `ollama.models` が返す同梱の実測を、製品の `measured` の形へ直す。
 *
 * **件数を添える**（`bundledCharsPerTokenSamples`）。同梱の値には件数が
 * 付いていないが、製品は読むときに添えている——同じにしないと、
 * 測定だけが当て推量の係数で `num_ctx` を決めることになる。
 */
export function measuredOf(bundled, samples) {
  const charsPerToken = Number(bundled?.charsPerToken);
  if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) return undefined;
  return { charsPerToken, charsPerTokenSamples: samples };
}

/* ── 決める ───────────────────────────────────────────── */

/**
 * この測定で送る `num_ctx` を決める。
 *
 * 順番は3つだけ。
 *
 * 1. **`--num-ctx` があれば、それに従う。** 作者が意図して固定する道は
 *    残す（VRAM に載る上限を探るときなど、測りたいのは決め方ではなく値である）
 * 2. 送るプロンプトの長さが分かるなら、**製品の関数**で決める
 * 3. どちらも無ければ、これまでの既定へ戻す（**黙って0にしない**）。
 *    なぜ戻したかは `fallbackReason` で添えられる——**分からなかったのか、
 *    決めないことにしたのか**は、記録の上で別のことである
 *
 * @param options.contextSizeForPrompt 製品から借りた関数
 *   （`loadContextSizeForPrompt`）。**渡してもらう形にしてある**ので、
 *   単体テストは本物の `src/core/chunker.ts` を渡して突き合わせられる
 * @returns `{ numCtx, source, ... }`。`source` は**記録と画面に出す**
 *   ——何で測ったのかが残らないと、あとから比べられない
 */
export function decideNumCtx(options) {
  const fallback = Number(options?.fallback);
  const explicit = options?.explicit;
  if (explicit !== null && explicit !== undefined) {
    return { numCtx: Number(explicit), source: "--num-ctx で指定" };
  }

  const promptChars = Number(options?.promptChars);
  const contextWindow = Number(options?.contextWindow);
  const outputTokens = Number(options?.outputTokens);
  const known =
    Number.isFinite(promptChars) &&
    promptChars > 0 &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0 &&
    Number.isFinite(outputTokens) &&
    outputTokens > 0;
  if (!known) {
    return {
      numCtx: fallback,
      // **なぜ決められなかったかを残す。** 「既定で測った」とだけ書いてあると、
      // あとから見た人は決め打ちへ戻ったのかどうかも分からない
      source: `既定（${options?.fallbackReason ?? "送る量かモデルの上限が分かりませんでした"}）`,
    };
  }

  const measured = options?.measured;
  const numCtx = options.contextSizeForPrompt({
    promptChars,
    outputTokens,
    contextWindow,
    measured,
  });
  return {
    numCtx,
    source: "プロンプトの長さから（製品と同じ道）",
    promptChars,
    outputTokens,
    contextWindow,
    // **当て推量で決めたのか実測で決めたのかを残す。** 同じ台でも係数が
    // 違えば `num_ctx` は変わる（1.383 と 0.7 では1.5倍ちがう）
    charsPerToken: measured?.charsPerToken ?? null,
  };
}
