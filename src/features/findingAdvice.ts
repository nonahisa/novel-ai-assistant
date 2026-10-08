import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { AIRegistry } from "../ai/registry";
import { AIError } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";
import { ChunkCache } from "../core/chunkCache";
import { sha1Text } from "../core/hash";
import {
  parseFindingAdvice,
  type FindingAdvice,
} from "../core/findingAdviceValidation";
import {
  buildFindingAdvicePrompt,
  FINDING_ADVICE_SCHEMA,
  FINDING_ADVICE_SYSTEM_PROMPT,
  FINDING_ADVICE_TEMPERATURE,
  FINDING_ADVICE_VERSION,
  type FindingAdvicePromptInput,
} from "../prompts/findingAdvice";

/**
 * 推敲の指摘1つへの短い助言（P-47。設計書6.96.5の［AIに相談］）。
 *
 * 校正・メモパネルの［AIに相談］を押したときだけ走る。**相談パネル（P-21）を
 * 通さない**——相談のシステム指示・材料・機能の一覧まで通すと、答えが長く
 * なり機能の案内や抽象的な選択肢まで混ざった（作者の報告 2026-10-04）。
 * 答えはパネルの中、押した指摘の行のすぐ下に出る。
 *
 * ## 同じ問いは作り直さない（規則4）
 *
 * 鍵は「依頼文の中身（一文・前後・指摘）のハッシュ＋プロバイダID＋モデル名＋
 * プロンプト版」（`chunkCache.ts` の鍵と同じ形。置き場も同じ `chunks.json`）。
 * 閉じてもう一度押したときに、課金の確認もAIの呼び出しも起きない。
 * **検証を通った答えだけ**を入れる。
 *
 * ## 割当は「相談」に従う（2026-10-08 作者の裁定）
 *
 * ボタンの名前が［AIに相談］で、「相談パネルで続ける」も相談の割当なので、
 * 名前と動きを揃える。相談パネル（`workChatPanel.ts`）と同じ鍵 `"chat"` で引く。
 * （旧：推敲を無料AIに割り当てた作者が、ここだけ相談の割当で動くと驚くとして
 * 推敲の割当に従っていた。有料なら `ai.paid.findingAdvice` の確認が出るので
 * 黙って課金されることはない）
 *
 * ## 本文は書き換えない
 *
 * 返すのは助言だけで、言い換え例も読むだけ（当てる口は持たない）。
 */

export type FindingAdviceOutcome =
  /** 答えが返り、検証を通った。`cached` は前に作ったものを出したか */
  | { kind: "answered"; advice: FindingAdvice; cached: boolean }
  /** 訊けなかった。**`reason` はそのまま行の下に出す1文** */
  | { kind: "failed"; reason: string }
  /**
   * 作者が断った・止めた・AIが未設定・繋がらない。
   * どれもダイアログか作者自身の操作で既に伝わっているので、行の下に重ねて書かない
   */
  | { kind: "cancelled" };

export interface FindingAdviceRequest {
  work: WorkEntry;
  /** AIの割当。**渡されなければ「AIが設定されていません」と伝えて終わる** */
  registry?: AIRegistry;
  material: FindingAdvicePromptInput;
  signal?: AbortSignal;
}

/** 確認ダイアログと記録に出す操作名。**1か所だけが持つ** */
const ACTION_LABEL = "推敲の指摘をAIに相談";

/** キャッシュと出力の上限に使う機能名 */
export const FINDING_ADVICE_FEATURE = "finding_advice";

export async function askFindingAdvice(
  request: FindingAdviceRequest
): Promise<FindingAdviceOutcome> {
  const resolved = request.registry?.resolve("chat");
  if (!resolved) {
    void vscode.window.showWarningMessage(
      "AIが設定されていません。詳細メニューの「AIの設定」から設定してください。"
    );
    return { kind: "cancelled" };
  }

  const userPrompt = buildFindingAdvicePrompt(request.material);
  const cacheBase = {
    feature: FINDING_ADVICE_FEATURE,
    promptVersion: FINDING_ADVICE_VERSION,
    providerId: resolved.provider.id,
    model: resolved.model,
  };
  // 依頼文そのものを鍵にする。一文・前後・指摘のどれが変わっても別の鍵になる
  const contentHash = sha1Text(userPrompt);

  /*
    **キャッシュを先に見る。** 当たれば繋がるかの確認も課金の確認も要らない
    （AIを呼ばないので）。読めなくても続ける——キャッシュは作り直せる
  */
  const cache = new ChunkCache(request.work);
  try {
    await cache.load();
    const hit = cache.get(contentHash, cacheBase);
    if (isFindingAdvice(hit)) return { kind: "answered", advice: hit, cached: true };
  } catch {
    // 読めないキャッシュは無いものとして扱う
  }

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      ACTION_LABEL,
      resolved.model
    ))
  ) {
    return { kind: "cancelled" };
  }

  // 1クリックが必ず1回の呼び出しになる（キャッシュに当たらなかったときだけ）
  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: ACTION_LABEL,
    remember: { id: "ai.paid.findingAdvice" },
    work: request.work,
    model: resolved.model,
    calls: 1,
    detail:
      "送るのは指摘の一文と前後の段落、指摘の中身だけです（本文全体は送りません）。\n" +
      "返るのは短い助言だけで、本文は書き換わりません。",
  });
  if (!ok) return { kind: "cancelled" };

  useLogFile(request.work.folderPath);
  logStep(
    `推敲の指摘の相談: ${request.work.title} / ` +
      `${resolved.provider.displayName} / ${resolved.model} / v${FINDING_ADVICE_VERSION}`
  );

  let text: string;
  try {
    const response = await resolved.provider.generate({
      systemPrompt: FINDING_ADVICE_SYSTEM_PROMPT,
      userPrompt,
      model: resolved.model,
      temperature: FINDING_ADVICE_TEMPERATURE,
      // **見込みと実上限を分けて渡す**（設計書6.77の第2段）
      maxOutputTokens: resolveOutputTokensForSend(
        resolved.provider.id,
        resolved.model,
        FINDING_ADVICE_FEATURE
      ),
      plannedOutputTokens: resolveOutputTokensForPlanning(
        resolved.provider.id,
        resolved.model,
        FINDING_ADVICE_FEATURE
      ),
      jsonSchema: FINDING_ADVICE_SCHEMA,
      disableThinking: true,
      signal: request.signal,
      // **`numCtx` は渡さない。** 送るのは一文と前後だけなので、受け皿
      // （`ollamaProvider`）が実物から見積もって明示する（`notationAdvice.ts` と同じ）
      meta: {
        feature: FINDING_ADVICE_FEATURE,
        workFolder: request.work.folderPath,
      },
    });
    if (response.truncated) {
      return { kind: "failed", reason: "AIの答えが途中で切れました。" };
    }
    text = response.text;
  } catch (error) {
    // 中止は失敗ではない（作者が［止める］を押した）
    if (error instanceof AIError && error.kind === "aborted") {
      return { kind: "cancelled" };
    }
    if (request.signal?.aborted) return { kind: "cancelled" };
    // **本文は捨てない。** 通知には出さなくても、ログには残す（規則5）
    useLogFile(request.work.folderPath);
    logFailure(ACTION_LABEL, {
      詳細: error instanceof Error ? error.message : String(error),
    });
    return { kind: "failed", reason: "AIに相談できませんでした。ログに理由が残っています。" };
  }

  const advice = parseFindingAdvice(text, request.material);
  if (!advice) {
    useLogFile(request.work.folderPath);
    logFailure(ACTION_LABEL, {
      理由: "答えを読み取れません（空か、指示の言葉の返りか、形が違う）",
      応答: responseExcerptForLog(text),
    });
    return { kind: "failed", reason: "AIの答えを読み取れませんでした。" };
  }
  if (advice.dropped > 0) {
    // 捨てたことは黙らない（記録にだけ残す。画面には残ったものだけを出す）
    logStep(`推敲の指摘の相談: 言い換え ${advice.dropped}件を検証で捨てました`);
  }

  try {
    await cache.set(contentHash, cacheBase, advice);
    await cache.save();
  } catch (error) {
    // 覚えられなくても答えは出す（次に押したときにもう一度訊くだけ）
    logFailure(`${ACTION_LABEL}（キャッシュの保存）`, {
      詳細: error instanceof Error ? error.message : String(error),
    });
  }
  return { kind: "answered", advice, cached: false };
}

/** キャッシュから出した値が、助言の形をしているか（古い形・壊れた値を出さない） */
function isFindingAdvice(value: unknown): value is FindingAdvice {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.point === "string" &&
    typeof record.noNeed === "boolean" &&
    Array.isArray(record.examples) &&
    record.examples.every(
      (example: unknown) =>
        typeof example === "object" &&
        example !== null &&
        typeof (example as Record<string, unknown>).from === "string" &&
        typeof (example as Record<string, unknown>).to === "string"
    )
  );
}
