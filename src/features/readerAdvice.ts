import type { WorkEntry } from "../models/types";
import type { PostingSiteId } from "../models/posting";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import {
  resolveOutputLimitForSend,
  resolveOutputTokensForPlanning,
  truncatedOutputAdvice,
} from "../ai/outputLimit";
import { estimateCallsTimeFor } from "../ai/runTimeEstimate";
import { describeCallTimeEstimate } from "../core/etaEstimate";
import type { AdvicePolicyStore } from "../core/advicePolicyStore";
import { ChunkCache } from "../core/chunkCache";
import { hashText } from "../core/hash";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";
import { PostingStore } from "../core/postingStore";
import { buildReaderAdviceMaterials } from "../core/readerAdvice";
import {
  validateReaderAdviceAnswer,
  type ReaderAdviceAnswer,
} from "../core/readerAdviceValidation";
import { measureParts } from "../core/usageLog";
import {
  READER_ADVICE_SCHEMA,
  READER_ADVICE_SYSTEM_PROMPT,
  READER_ADVICE_TEMPERATURE,
  READER_ADVICE_VERSION,
  buildReaderAdvicePrompt,
  buildReaderAdviceTonePrompt,
  formatReaderAdviceMaterial,
} from "../prompts/readerAdvice";
import { confirmRun } from "../views/notify";
import { confirmProviderReachable } from "./aiConnectivity";
import { withAiTurnProgress } from "./aiTurn";

/**
 * 執筆統計の「AIに助言をもらう」（設計書6.79.7.3。P-40）。
 *
 * **押したときだけAIを呼ぶ。** パネルを開いただけでは呼ばない——読者の
 * 反応を見にきたたびに料金と待ち時間がかかるのは筋が悪い。
 *
 * **材料は相談パネルと同じもの**（`buildReaderAdviceMaterials`）。
 * 違うのは答えの形（こちらは見立て＋見てほしい所）と、言い方の指針を
 * ここで足すこと（相談はもう持っている）。
 */

/** 割当のキー。**相談と同じ割当を使う**——同じ材料を読む相談役である */
const READER_ADVICE_FEATURE = "chat" as const;
/** 使用量の記録・出力量の実測を引く機能名 */
const READER_ADVICE_METER = "reader_advice";
/**
 * 速さを測っていないときの、1回あたりの決め打ちの秒数。
 * 材料は数千字で、答えは数百字。あらすじ1話ぶん（15秒）より重い。
 */
const READER_ADVICE_FALLBACK_SECONDS = 30;

export type ReaderAdviceOutcome =
  | {
      kind: "answer";
      answer: ReaderAdviceAnswer;
      /** 前の答えを出したか（材料・モデル・プロンプトの版が同じ） */
      fromCache: boolean;
      model: string;
      provider: string;
    }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" };

export interface ReaderAdviceDeps {
  ai: AIRegistry;
  /** 作者のタイプ別の助言方針（6.86）。無ければ言い方の指針を足さない */
  advicePolicies?: AdvicePolicyStore;
}

export async function requestReaderAdvice(
  work: WorkEntry,
  site: PostingSiteId,
  deps: ReaderAdviceDeps,
  options: { force?: boolean } = {}
): Promise<ReaderAdviceOutcome> {
  useLogFile(work.folderPath);

  let materials;
  try {
    materials = buildReaderAdviceMaterials(await new PostingStore(work).load(), site);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("読者の反応の助言: 投稿状態の台帳を読めませんでした", {
      作品: work.title,
      内容: detail,
    });
    return { kind: "failed", message: `投稿状態の台帳を読めませんでした：${detail}` };
  }
  if (materials.length === 0) {
    return {
      kind: "failed",
      message: "このサイトには、話ごとの読者の反応の記録がありません。",
    };
  }

  const resolved = await ensureConfigured(deps.ai, READER_ADVICE_FEATURE);
  if (!resolved) return { kind: "cancelled" };

  const tone = buildReaderAdviceTonePrompt(
    deps.advicePolicies?.getEffective(work.id),
    new Date()
  );
  const userPrompt = buildReaderAdvicePrompt({
    workTitle: work.title,
    materials,
    tone,
  });

  /*
    **鍵は送る文そのもの**（実装ルール4）。材料が1つでも変われば（取り込み
    直した・言い方の指針が変わった）引き直しになり、同じなら前の答えを出す。
    プロバイダIDとモデル名とプロンプトの版は `CacheKeyBase` が持つ。
  */
  const cache = new ChunkCache(work);
  await cache.load();
  const cacheBase = {
    feature: READER_ADVICE_METER,
    promptVersion: READER_ADVICE_VERSION,
    providerId: resolved.provider.id,
    model: resolved.model,
  };
  const hash = hashText(`${READER_ADVICE_SYSTEM_PROMPT}\u0000${userPrompt}`);
  const cached = options.force ? undefined : cache.get(hash, cacheBase);
  if (typeof cached === "string") {
    // **前の答えも、いまの材料で確かめ直す**（検査を後から強めた日にも効くように）
    const answer = validateReaderAdviceAnswer(cached, materials);
    if (answer) {
      logStep(`読者の反応の助言: 前の答えを出しました（${resolved.model}）`);
      return {
        kind: "answer",
        answer,
        fromCache: true,
        model: resolved.model,
        provider: resolved.provider.displayName,
      };
    }
  }

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "読者の反応の助言",
      resolved.model
    ))
  ) {
    return { kind: "cancelled" };
  }

  /*
    **目安は送る量と速さから出す**（設計書6.8.19。0.75.17）。料金の断りは
    ほかの機能の確認画面（各話あらすじ）と同じ言い方にそろえる。
  */
  const timeEstimate = estimateCallsTimeFor({
    providerId: resolved.provider.id,
    model: resolved.model,
    feature: READER_ADVICE_METER,
    inputChars: [READER_ADVICE_SYSTEM_PROMPT.length + userPrompt.length],
    fallbackSecondsPerCall: READER_ADVICE_FALLBACK_SECONDS,
  });
  const costNotice = resolved.provider.isPaid
    ? `\n${resolved.provider.displayName} は呼び出すたびに課金されます。`
    : "";
  const siteLabels = materials.map((material) => material.siteLabel).join("・");
  const confirmed = await confirmRun(
    `${siteLabels}の読者の反応を、AIに読んでもらいます（1回呼び出します。送る量 約${(
      READER_ADVICE_SYSTEM_PROMPT.length + userPrompt.length
    ).toLocaleString("ja-JP")}字）。\n` +
      `モデル: ${resolved.model} / ` +
      (timeEstimate ? describeCallTimeEstimate(timeEstimate) : "目安は出せません") +
      costNotice,
    "実行",
    // 作品名を1行目に出す（ほかのAI機能の確認と同じ。どの作品かを押す前に読ませる）
    { remember: { id: "ai.run.readerAdvice" }, workTitle: work.title }
  );
  if (!confirmed) return { kind: "cancelled" };

  const materialChars = materials
    .map(formatReaderAdviceMaterial)
    .reduce((sum, text) => sum + text.length, 0);
  logStep(
    `読者の反応の助言: v${READER_ADVICE_VERSION} / ${resolved.provider.displayName} / ` +
      `${resolved.model} / 材料 ${materialChars}字 / 言い方の指針 ${tone ? "あり" : "なし"}`
  );

  const outputLimit = resolveOutputLimitForSend(
    resolved.provider.id,
    resolved.model,
    READER_ADVICE_METER
  );
  let outcome: ReaderAdviceOutcome = { kind: "cancelled" };

  await withAiTurnProgress(
    "読者の反応を読んでいます",
    { label: "読者の反応の助言" },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        const response = await resolved.provider.generate({
          systemPrompt: READER_ADVICE_SYSTEM_PROMPT,
          userPrompt,
          model: resolved.model,
          temperature: READER_ADVICE_TEMPERATURE,
          maxOutputTokens: outputLimit.tokens,
          // Ollama の `num_ctx` の確保に使う（実装ルール6）。上限としては送らない
          plannedOutputTokens: resolveOutputTokensForPlanning(
            resolved.provider.id,
            resolved.model,
            READER_ADVICE_METER
          ),
          jsonSchema: READER_ADVICE_SCHEMA as unknown as object,
          disableThinking: true,
          signal: controller.signal,
          meta: {
            feature: READER_ADVICE_METER,
            workFolder: work.folderPath,
            parts: measureParts(userPrompt, {
              材料: materialChars,
              言い方: tone?.length ?? 0,
            }),
          },
        });

        const answer = validateReaderAdviceAnswer(response.text, materials);
        if (!answer) {
          logFailure("読者の反応の助言", {
            理由: response.truncated
              ? "応答が上限で切り詰められました"
              : "応答を読み取れません",
            応答: responseExcerptForLog(response.text),
          });
          outcome = {
            kind: "failed",
            message: response.truncated
              ? truncatedOutputAdvice(outputLimit)
              : "AIの答えを読み取れませんでした。もう一度お試しください。",
          };
          return;
        }
        // 覚えるのは**読めた答えだけ**（読めなかった答えを次も出さない）
        await cache.set(hash, cacheBase, response.text);
        await cache.save();
        outcome = {
          kind: "answer",
          answer,
          fromCache: false,
          model: resolved.model,
          provider: resolved.provider.displayName,
        };
      } catch (error) {
        if (error instanceof AIError && error.kind === "aborted") {
          outcome = { kind: "cancelled" };
          return;
        }
        const message =
          error instanceof AIError
            ? `${error.message} ${recoveryForAIError(error)}`
            : error instanceof Error
              ? error.message
              : String(error);
        logFailure("読者の反応の助言", {
          種別: error instanceof AIError ? error.kind : "unknown",
          内容: message,
        });
        outcome = { kind: "failed", message };
      }
    }
  );
  return outcome;
}
