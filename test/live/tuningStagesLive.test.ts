import * as fs from "node:fs";
import { describe, expect, test } from "vitest";
import { window, workspace } from "../unit/support/vscodeStub";
import { disposeLog } from "../../src/core/logger";
import { useMemoryTuningStore } from "../unit/support/tuningStore";
import { MeteredProvider } from "../../src/ai/meteredProvider";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { SakuraProvider } from "../../src/ai/sakuraProvider";
import type { AIProvider } from "../../src/ai/types";
import { modelTuningRaw } from "../../src/core/modelTuning";
import {
  setFileReaderForTests,
  vscodeFileReaderForTests,
} from "../../src/core/fileRead";
import { runTuningStages } from "../../src/features/tuningStageRunners";
import { plannedStages } from "../../src/core/tuningStages";
import { describeTypoAccuracyRecord } from "../../src/core/tuningAccuracy";
import { readOllamaPsWith } from "../../src/core/gpuLoad";
import { TUNING_WORK_PARAGRAPHS } from "../../src/core/tuningWorkSample";
import { localFetch } from "../../src/ai/fetchTimeouts";

/**
 * AIチューニング「仕事に近い形で測る」を、**実物のAI**で回す（設計書6.49.9）。
 *
 * **製品と同じ道を通す**（CLAUDE.md「実接続の測定は、製品と同じ検証を
 * 通す」）——プロバイダを関所（`MeteredProvider`）で包み、段の並び
 * （`runTuningStages`）をそのまま走らせる。台帳は**記憶の中**に置くので、
 * 作者の機械の本物の台帳には書かない。
 *
 *   $env:NOVELAI_TUNING_LIVE = "ollama:gemma4:e4b,sakura:llm-jp-3.1-8x13b-instruct4"
 *   $env:NOVELAI_TUNING_OUT = "C:/…/結果.json"   # 任意。覚えた値を書き出す
 *   $env:NOVELAI_SAKURA_BUDGET = "40"            # 任意。さくらへ送る上限（既定40）
 *   npx vitest run --config vitest.live.config.mts test/live/tuningStagesLive.test.ts
 *
 * **さくらの鍵は環境変数 `SAKURA_AI_ACCOUNT_TOKEN` からだけ読む。** 値は
 * 表示しない（ログの伏せ字にも登録する）。**送る回数は上限で止める**——
 * `globalThis.fetch` を包んで、さくらへの POST を数え、上限に達したら
 * 送らずに失敗させる（プロバイダの中の再試行も数えるため、`generate` の
 * 外では数えない）。
 *
 * **決めていなければ飛ばす**（実データを持たない環境で赤くしない）。
 */

const TARGETS = (process.env.NOVELAI_TUNING_LIVE ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)
  .map((entry) => {
    const at = entry.indexOf(":");
    return { providerId: entry.slice(0, at), model: entry.slice(at + 1) };
  });

const SAKURA_BUDGET = Number(process.env.NOVELAI_SAKURA_BUDGET ?? "40");

/**
 * 走らせる段を絞る（任意。`accuracy` なら精度の目安だけ）。
 *
 *   $env:NOVELAI_TUNING_STAGES = "accuracy"
 *
 * 決めていなければ、製品と同じく全部の段を走らせる。
 */
const STAGE_FILTER = (process.env.NOVELAI_TUNING_STAGES ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

/**
 * 精度の段の**生の答え**を結果に写す（任意）。
 *
 *   $env:NOVELAI_TUNING_RAW = "1"
 *
 * 検算が「本文に無い引用」で落とした指摘が、モデルの写し間違いか、検算が
 * 厳しすぎるのかを切り分けるために使う（2026-09-26、gpt-oss-120b）。
 * 写すのは同梱の文への答えだけで、作者の作品は通らない。
 */
const CAPTURE_RAW = process.env.NOVELAI_TUNING_RAW === "1";

/** 精度の段の回か（同梱の4段落がすべて入っている） */
function isAccuracyPrompt(userPrompt: string): boolean {
  return TUNING_WORK_PARAGRAPHS.every((paragraph) => userPrompt.includes(paragraph));
}

/** さくらへ送った回数（プロバイダの中の再試行も含む） */
let sakuraPosts = 0;

function installBudgetedFetch(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("sakura.ad.jp") && (init?.method ?? "GET").toUpperCase() === "POST") {
      if (sakuraPosts >= SAKURA_BUDGET) {
        throw new Error(`さくらへ送る上限（${SAKURA_BUDGET}回）に達したので送りません。`);
      }
      sakuraPosts += 1;
    }
    return original(input, init);
  }) as typeof fetch;
}

function providerFor(providerId: string): AIProvider {
  if (providerId === "ollama") return new MeteredProvider(new OllamaProvider());
  if (providerId === "sakura") {
    const token = process.env.SAKURA_AI_ACCOUNT_TOKEN;
    if (!token) throw new Error("SAKURA_AI_ACCOUNT_TOKEN がありません。");
    const context = {
      secrets: {
        get: async () => token,
        store: async () => {},
        delete: async () => {},
      },
    } as unknown as ConstructorParameters<typeof SakuraProvider>[0];
    return new MeteredProvider(new SakuraProvider(context));
  }
  throw new Error(`この試験では ${providerId} を扱いません。`);
}

describe.skipIf(TARGETS.length === 0)("AIチューニング：仕事に近い形で測る（実接続）", () => {
  test(
    "段を並べて測り、覚えた値を示す",
    async () => {
      workspace.getConfiguration = () =>
        ({
          get: <T>(_key: string, defaultValue: T): T => defaultValue,
          inspect: () => ({}),
        }) as unknown as ReturnType<typeof workspace.getConfiguration>;
      /*
        **読み口を記憶の中のファイルへ向ける**（単体テストの
        `support/setup.ts` と同じ）。実接続の設定はその下ごしらえを
        持たないので、向けないと台帳の読み直しが本物のディスクへ行き、
        書いた直後の確かめが「消えた」と判定する（1回目の実行で踏んだ）。
      */
      setFileReaderForTests(vscodeFileReaderForTests());
      await useMemoryTuningStore({});
      installBudgetedFetch();
      /*
        **操作ログの行を控える**（何を拾えず、何を誤りでない所へ指摘したかは
        作者の画面には出さず、ログにだけ書く）。代役の出力窓は捨てるので、
        書き先を差し替えてから最初の1行を書かせる
      */
      const logLines: string[] = [];
      disposeLog();
      window.createOutputChannel = (() => ({
        appendLine: (line: string) => {
          logLines.push(line);
        },
        show() {},
        dispose() {},
      })) as unknown as typeof window.createOutputChannel;

      const report: Record<string, unknown> = {};
      for (const target of TARGETS) {
        const provider = providerFor(target.providerId);
        /*
          **関所の外側で控える**（製品の道はそのまま通す）。答えの中身を
          書き換えないので、検算と数え方は製品と同じになる
        */
        const rawAnswers: string[] = [];
        if (CAPTURE_RAW) {
          const inner = provider.generate.bind(provider);
          provider.generate = async (params) => {
            const result = await inner(params);
            if (isAccuracyPrompt(params.userPrompt)) rawAnswers.push(result.text);
            return result;
          };
        }
        const startedPosts = sakuraPosts;
        const started = Date.now();
        const stageTarget = {
          providerId: target.providerId,
          local: target.providerId === "ollama",
        };
        /*
          **モデルの大きさは製品と同じ口から引く**（入口 `measureContext` は
          `registry.modelInfoFor` → `getModel`）。精度の段が 20B で頼み方を
          選び分けるので、渡さないと製品と違う頼み方で測ることになる
        */
        // 取れなくても止めない（製品の入口と同じ。手元は小さい側・クラウドは大きい側）
        const info = provider.getModel
          ? await provider.getModel(target.model).catch(() => undefined)
          : undefined;
        const stages = plannedStages(stageTarget).filter(
          (stage) => STAGE_FILTER.length === 0 || STAGE_FILTER.includes(stage.id)
        );
        const result = await runTuningStages({
          provider,
          model: target.model,
          target: stageTarget,
          signal: new AbortController().signal,
          report: () => {},
          ...(info !== undefined
            ? { modelInfo: { parameterSize: info.parameterSize, tier: info.tier } }
            : {}),
          // 製品と同じく、Ollama では測った直後に載っているモデルを見る
          ...(target.providerId === "ollama"
            ? {
                readLoadedModels: () =>
                  readOllamaPsWith((signal) =>
                    localFetch("http://127.0.0.1:11434/api/ps", { signal }, 2000)
                  ),
              }
            : {}),
        }, stages);
        const ledger = modelTuningRaw(target.providerId, target.model);
        report[`${target.providerId}/${target.model}`] = {
          所要秒: Math.round((Date.now() - started) / 1000),
          さくらへ送った回数: sakuraPosts - startedPosts,
          結果: result.summaries,
          反映の候補: result.proposal,
          覚えた値: {
            workSecondsPer1000Chars: ledger?.workSecondsPer1000Chars,
            workFixedSeconds: ledger?.workFixedSeconds,
            thinkingSeen: ledger?.thinkingSeen,
            thinkingOffWorks: ledger?.thinkingOffWorks,
            thinkingOverheadTokens: ledger?.thinkingOverheadTokens,
            workOtherModelsLoaded: ledger?.workOtherModelsLoaded,
            workSplitAcrossCpu: ledger?.workSplitAcrossCpu,
            outputTokensPerSecond: ledger?.outputTokensPerSecond,
            inputTokensPerSecond: ledger?.inputTokensPerSecond,
            charsPerToken: ledger?.charsPerToken,
            誤字脱字の精度: describeTypoAccuracyRecord(ledger),
            直し方が違う: ledger?.typoAccuracyWrongFixes,
          },
          大きさ: info?.parameterSize ?? null,
          精度のログ: logLines.filter((line) => line.includes("精度")),
          ...(CAPTURE_RAW ? { 精度の生の答え: rawAnswers } : {}),
          止まった理由: result.fatal?.message,
        };
        console.log(JSON.stringify(report[`${target.providerId}/${target.model}`], null, 2));
      }
      report["さくらへ送った回数の合計"] = sakuraPosts;
      const out = process.env.NOVELAI_TUNING_OUT;
      if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      expect(Object.keys(report).length).toBeGreaterThan(1);
    },
    // 手元の大きいモデルは、考える回だけで数分かかる
    60 * 60 * 1000
  );
});
