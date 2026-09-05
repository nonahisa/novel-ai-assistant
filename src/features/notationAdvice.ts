import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { AIRegistry } from "../ai/registry";
import { AIError } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { logFailure, logStep, responseExcerptForLog } from "../core/logger";
import {
  parseNotationAdvice,
  type NotationAdvice,
} from "../core/notationAdviceValidation";
import {
  buildNotationAdvicePrompt,
  buildNotationAdviceSchema,
  NOTATION_ADVICE_SYSTEM_PROMPT,
  NOTATION_ADVICE_VERSION,
  type NotationAdviceGroup,
} from "../prompts/notationAdvice";

/**
 * 表記ゆれの1組について、どちらに揃えるかをAIに訊く（P-33、設計書6.73）。
 *
 * 表記ゆれ検知（`checkNotation.ts`）は**機械判定のまま変えない。**
 * ここが受け持つのは「見つけたあと、どちらに揃えるか」だけである。
 *
 * ## 1クリック1問
 *
 * 作者が指摘の「AIに訊く」を押したときだけ走る。送るのは**その組の情報だけ**
 * （各表記・出現数・出現例）で、本文全体もチャンクも送らない。
 * **キャッシュは持たない**——同じ組を二度訊くのは作者が明示的に押したときだけで、
 * そのときは新しい答えが欲しいはずである。
 *
 * ## 本文は書き換えない
 *
 * 返すのは助言だけで、提案パネルは指摘の下に文として出す。揃えるかどうかも、
 * どう直すかも作者が決める（既存の指摘の「適用」や「今後直さない」がそのまま使える）。
 *
 * ## 失敗しても、指摘は消さない
 *
 * 読めない答え・通信の失敗は、**理由を短く返すだけ**にする。呼び出し側は
 * それを指摘の下に出す。通知を連打しない——1件ずつ押す操作なので、
 * 押すたびにモーダルが出ては相談にならない。
 */

export type NotationAdviceOutcome =
  /** 答えが返り、選択肢の中の表記として読めた */
  | { kind: "answered"; advice: NotationAdvice }
  /**
   * 訊けなかった。**`reason` はそのまま指摘の下に出す1文**にしてある
   * （呼び出し側で言葉を足さない）。通信の失敗も、読めない答えも、
   * 指摘そのものを消す理由にはならない
   */
  | { kind: "failed"; reason: string }
  /**
   * 作者が断った・AIが未設定・繋がらない。
   *
   * **`failed` と分ける。** どれもダイアログで既に伝わっているので、
   * 指摘の下にもう一度書くと、断ったのに失敗したように見える。
   */
  | { kind: "cancelled" };

export interface NotationAdviceRequest {
  work: WorkEntry;
  /** AIの割当。**渡されなければ「AIが設定されていません」と伝えて終わる** */
  registry?: AIRegistry;
  group: NotationAdviceGroup;
  signal?: AbortSignal;
}

/** 確認ダイアログと記録に出す操作名。**1か所だけが持つ** */
const ACTION_LABEL = "表記ゆれをAIに訊く";

export async function askNotationAdvice(
  request: NotationAdviceRequest
): Promise<NotationAdviceOutcome> {
  const { group } = request;
  if (group.forms.length === 0) return { kind: "cancelled" };

  /*
    **割当は「誤字脱字」に従う**（設計書6.73）。表記ゆれは校正の仲間であり、
    誤字脱字を無料AIに割り当てた作者が、ここだけ有料AIで動いては驚く。
  */
  const resolved = request.registry?.resolve("typo");
  if (!resolved) {
    void vscode.window.showWarningMessage(
      "AIが設定されていません。詳細メニューの「AIの設定」から設定してください。"
    );
    return { kind: "cancelled" };
  }

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）。
  // 繋がらないと分かっているのに料金の話をしても意味がない
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      ACTION_LABEL,
      resolved.model
    ))
  ) {
    return { kind: "cancelled" };
  }

  /*
    **押すたびに確認する。** 再チェック（P-23）はパネルを開いている間に
    一度だけにしているが、あちらは「本文が変わっていなければAIを呼ばない」
    ので空振りがある。こちらは1クリックが必ず1回の呼び出しになるため、
    押した回数がそのまま料金になる。
  */
  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: ACTION_LABEL,
    model: resolved.model,
    calls: 1,
    detail:
      `送るのは「${group.label}」の表記と出現例だけです（本文全体は送りません）。\n` +
      "返るのは助言だけで、本文は書き換わりません。",
  });
  if (!ok) return { kind: "cancelled" };

  logStep(
    `表記ゆれの問い合わせ: ${request.work.title} / ${group.label} / ` +
      `${resolved.provider.displayName} / ${resolved.model} / v${NOTATION_ADVICE_VERSION}`
  );

  let text: string;
  try {
    const response = await resolved.provider.generate({
      systemPrompt: NOTATION_ADVICE_SYSTEM_PROMPT,
      userPrompt: buildNotationAdvicePrompt({
        workTitle: request.work.title,
        group,
      }),
      model: resolved.model,
      // 判断であって創作ではない。揺らす理由がない
      temperature: 0.0,
      // **見込みと実上限を分けて渡す**（設計書6.77の第2段）。返るのは
      // どちらに揃えるかと理由だけだが、渡さないと関所も `num_ctx` も
      // 設定値（既定16,384）で数える
      maxOutputTokens: resolveOutputTokensForSend(
        resolved.provider.id,
        resolved.model
      ),
      plannedOutputTokens: resolveOutputTokensForPlanning(
        resolved.provider.id,
        resolved.model
      ),
      jsonSchema: buildNotationAdviceSchema(group),
      disableThinking: true,
      signal: request.signal,
      // **`numCtx` は渡さない。** 送るのは1組ぶんなので、受け皿が実物から
      // 見積もるほうが正確になる（`recheckProposal.ts` と同じ）
      meta: {
        feature: "notation_advice",
        workFolder: request.work.folderPath,
      },
    });
    if (response.truncated) {
      return { kind: "failed", reason: "AIの答えが途中で切れました。" };
    }
    text = response.text;
  } catch (error) {
    // 中止は失敗ではない（作者が自分で止めた）
    if (error instanceof AIError && error.kind === "aborted") {
      return { kind: "cancelled" };
    }
    // **本文は捨てない。** 通知には出さなくても、ログには残す（CLAUDE.md 規則5）
    logFailure(ACTION_LABEL, {
      組: group.label,
      詳細: error instanceof Error ? error.message : String(error),
    });
    return { kind: "failed", reason: "AIに訊けませんでした。" };
  }

  const advice = parseNotationAdvice(
    text,
    group.forms.map((form) => form.surface)
  );
  if (!advice) {
    logFailure(ACTION_LABEL, {
      組: group.label,
      理由: "答えを読み取れません（選択肢に無い表記か、形が違う）",
      応答: responseExcerptForLog(text),
    });
    return { kind: "failed", reason: "AIの答えを読み取れませんでした。" };
  }

  return { kind: "answered", advice };
}

/**
 * 答えを、指摘の下に出す1行にする。
 *
 * **「揃えない」は言い方を変える。** 「『揃えない』に揃える」では意味が通らない。
 * 理由が読み取れなかったときも、答えそのものは出す（黙って消さない）。
 */
export function describeNotationAdvice(advice: NotationAdvice): string {
  const head = advice.noUnify
    ? "AIの答え：揃えないほうがよい"
    : `AIの答え：「${advice.choice}」に揃える`;
  return advice.reason
    ? `${head}——${advice.reason}`
    : `${head}（理由は返りませんでした）`;
}
