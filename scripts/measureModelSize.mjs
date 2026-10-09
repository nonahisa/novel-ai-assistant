// 測るときの「モデルの大きさに合わせた頼み方」を、**製品と同じ判断で決める**。
//
// ## なぜ要るか（2026-10-10）
//
// 製品は、送り先のモデルの大きさで頼み方を変える（`src/ai/capability.ts`）。
// 誤字脱字は 20B 未満に小さいモデル向けの文（P-09 の 1.1）、矛盾検知は
// 抑制版（strict）と観点の絞り、逸脱は「逸脱」だけ。
//
// MCP の `novel.run` は相手のモデルを当てにいかないので、**指定が無ければ
// 大きいモデル向け**で組む（矛盾検知は「絞る＋ゆるめる」）。ところが台本は
// その指定を渡していなかった——2026-10-05・10-08 の `gemma4:e4b` の誤字脱字は
// **製品が e4b へ送らない 1.2 の文で測っていた**（記録の `options` が空、
// `promptVersion` が 1.2）。
//
// ## 判断を写さない
//
// 「20B 未満は small」をここへ書き写すと、製品が境目を引き直した日に
// 測定だけが古い境目で回り続ける。**束（`dist/core-bundle.mjs`）から製品の
// 関数そのもの**（`useSmallModelTypoPrompt`・`capabilityProfile`・`inferTier`）を
// 借りる（`measureNumCtx.mjs` の `contextSizeForPrompt` と同じやり方）。
//
// ここに在るのは「製品の判断の結果を、MCP の `options` の名前へ言い換える表」
// だけである。名前（small/large・light/all・strict/loose）の受け手は
// `src/mcp/tools/typo.ts`・`episode.ts`・`contradiction.ts`。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./mcpClient.mjs";
import { CORE_BUNDLE_PATH } from "./measureNumCtx.mjs";

/** 借りる関数の源。束が古くなっていないかを見るために要る */
const CAPABILITY_SOURCES = [
  path.join(REPO_ROOT, "src", "ai", "capability.ts"),
  path.join(REPO_ROOT, "src", "ai", "types.ts"),
];

/**
 * 製品の判断を束から借りる。
 *
 * **束が無ければ止める**（`loadContextSizeForPrompt` と同じ作法）。ここで
 * 当て推量へ落ちると、「製品と同じ頼み方で測った」という記録だけが残る。
 *
 * @returns `{ useSmallModelTypoPrompt, capabilityProfile, inferTier, stale }`
 */
export async function loadCapability() {
  if (!fs.existsSync(CORE_BUNDLE_PATH)) {
    throw new Error(
      `${path.relative(REPO_ROOT, CORE_BUNDLE_PATH)} がありません。` +
        "先に npm run bundle:core を実行してください" +
        "（モデルの大きさに合わせた頼み方を、製品の関数から借りています）。"
    );
  }
  const bundledAt = fs.statSync(CORE_BUNDLE_PATH).mtimeMs;
  const stale = CAPABILITY_SOURCES.some(
    (file) => fs.statSync(file).mtimeMs > bundledAt
  );
  const loaded = await import(pathToFileURL(CORE_BUNDLE_PATH).href);
  // 束ねる側（`scripts/bundleCore.mjs`）が付ける名前。`ai/capability.ts` → `ai$capability`
  const capability = loaded.ai$capability;
  const types = loaded.ai$types;
  const borrowed = {
    useSmallModelTypoPrompt: capability?.useSmallModelTypoPrompt,
    capabilityProfile: capability?.capabilityProfile,
    inferTier: types?.inferTier,
  };
  const missing = Object.entries(borrowed)
    .filter(([, value]) => typeof value !== "function")
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `束に ${missing.join("・")} がありません（npm run bundle:core で束ね直してください）。`
    );
  }
  return { ...borrowed, stale };
}

/**
 * 製品の判断を、MCP の `options` の名前へ言い換える表。
 *
 * **大きさで頼み方を変える機能だけ**を挙げる（推敲・伏線・事実の照合・
 * 単話プロット・表記ゆれは、製品が大きさで変えない）。
 */
const OPTION_TABLE = {
  typo: ({ typoSmall }) => ({ modelSize: typoSmall ? "small" : "large" }),
  deviation: ({ profile }) => ({
    modelSize: profile.narrowDeviationTypes ? "small" : "large",
  }),
  contradiction: ({ profile }) => ({
    categories: profile.narrowContradictionCategories ? "light" : "all",
    suppression: profile.suppressUncertainContradictions ? "strict" : "loose",
  }),
};

/**
 * 頼み方を1行で書く（結果の行と、回す前の断りに出す）。
 * 大きさで頼み方が変わらない機能では null（行を足さない）。
 */
export function describeModelSize(decision, promptVersion) {
  // 変わらない機能では黙る。変わる機能で決められなかったときは書く
  if (!decision?.sizeDependent) return null;
  const version = promptVersion ? `、版 ${promptVersion}` : "";
  if (!decision.decided) {
    return `頼み方: 大きさで決めていません（${decision.reason}${version}）`;
  }
  const chosen = Object.entries(decision.product)
    .map(([name, value]) => `${name}=${value}`)
    .join("・");
  return (
    `頼み方: ${chosen}（申告の大きさ ${decision.parameterSize ?? "取れず"}・` +
    `ティア ${decision.tier}${version}／${decision.source}）`
  );
}

/** 大きさで頼み方が変わる feature か */
export function isSizeDependentFeature(feature) {
  return Object.hasOwn(OPTION_TABLE, feature);
}

/**
 * 製品と同じ頼み方になる `options` を決める。
 *
 * - **打たれた `--option` が勝つ**（頼み方を振って比べる道を残す）。勝った
 *   名前は `kept` に出す——記録から「製品の条件ではない」と読めるように
 * - **さくらでは決めない**。製品は大きさを `ai/sakuraProvider.ts`（`vscode` を
 *   引く）で読むので束から借りられない。黙って大きいモデル向けで回さず、
 *   理由を返して呼ぶ側に警告させる
 * - 大きさが取れなかったときは、製品と同じく `undefined` のまま判断へ渡す
 *   （手元は抑える側へ落ちる。`capability.ts` の `suppressUncertain`）
 *
 * @param {object} input
 * @param {string} input.feature
 * @param {string} input.runner `--runner` の値（ollama・sakura）
 * @param {string|null|undefined} input.parameterSize `ollama.models` の申告（"8.0B" など）
 * @param {Record<string,string>} input.given 打たれた `--option`
 * @param {{ useSmallModelTypoPrompt: Function, capabilityProfile: Function, inferTier: Function } | null} input.capability
 */
export function decideProductOptions({
  feature,
  runner,
  parameterSize,
  given,
  capability,
}) {
  const givenOptions = { ...(given ?? {}) };
  if (!isSizeDependentFeature(feature)) {
    return {
      options: givenOptions,
      decision: {
        sizeDependent: false,
        decided: false,
        reason: "この機能は製品がモデルの大きさで頼み方を変えません",
      },
    };
  }
  if (runner !== "ollama") {
    return {
      options: givenOptions,
      decision: {
        sizeDependent: true,
        decided: false,
        reason:
          "さくらのモデルの大きさは製品が sakuraProvider（vscode を引く）で読むため、台本では決めていません。" +
          "製品と同じ条件にするなら --option で指定してください",
      },
    };
  }
  if (!capability) {
    throw new Error("製品の判断（capability）を借りられていません。");
  }

  const providerId = "ollama";
  const size = parameterSize ?? null;
  // **製品と同じく、ティアは大きさから導く**（`ai/ollamaProvider.ts` が `inferTier` を通す）
  const tier = capability.inferTier(size, providerId);
  const capabilityInput = { tier, providerId, parameterSize: size ?? undefined };
  const profile = capability.capabilityProfile(capabilityInput);
  const typoSmall = capability.useSmallModelTypoPrompt(capabilityInput);
  const product = OPTION_TABLE[feature]({ profile, typoSmall });

  const kept = Object.keys(product).filter((name) =>
    Object.hasOwn(givenOptions, name)
  );
  return {
    // **打たれたものを後ろに置く**（打たれた値が勝つ）
    options: { ...product, ...givenOptions },
    decision: {
      sizeDependent: true,
      decided: true,
      providerId,
      parameterSize: size,
      tier,
      product,
      kept,
      source:
        kept.length === 0
          ? "製品と同じ判断（ai/capability.ts を束から借りた）"
          : `製品と同じ判断。ただし ${kept.join("・")} は --option の値を使った（製品の条件ではありません）`,
    },
  };
}
