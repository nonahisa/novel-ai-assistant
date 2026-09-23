/**
 * **まるごと読む**矛盾検知の、クラウドへ送る前の同意（作者の裁定 A3⑤、
 * 2026-09-23。設計書6.10.7）。
 *
 * ## 何を決めたか
 *
 * - **クラウドのAIでまるごと読むときは、毎回同意を取る。** 分けて読むときも
 *   本文は外へ出るが、まるごと読むと**作品が丸ごと1つのサービスへ渡る**。
 *   作者の明示の指示なしに越えてよい線ではない（6.10.7）
 * - **覚えさせない。** 「以降は訊かない」を出さない。作品は書き足されて
 *   いくので、前回の同意は今回の本文への同意ではない
 * - **手元のAIでは同意を取らない**（原稿が外へ出ない）。時間の目安は出す
 *
 * ## 料金を円で言わない理由
 *
 * この拡張機能は各社の料金表を持っていない（料金はサービス・モデル・時期で
 * 変わり、同梱すれば必ず古くなる）。**当て推量の金額を実際の金額の顔で
 * 出さない**——量（字数とトークン）を上限寄りに出し、金額は分からないと言う
 * （誤字脱字の `buildTypoCheckCostNotice` と同じ流儀）。
 *
 * サービス名は呼ぶ側がプロバイダの表示名を渡す（規則5：決め打ちしない）。
 *
 * VS Code API に依存しない。
 */

export interface WholeReadConsent {
  /** 送り先の表示名（プロバイダの `displayName`） */
  readonly serviceName: string;
  /** 送る本文の字数 */
  readonly bodyChars: number;
  /** 指示と設定資料を含めて送る字数（2回目の突き合わせを含む上限寄り） */
  readonly totalChars: number;
  /** 何回に区切って送るか */
  readonly calls: number;
  /** 入力のトークン数の目安 */
  readonly inputTokens: number;
  /** 出力のトークン数の上限（1回の上限 × 回数） */
  readonly maxOutputTokens: number;
}

/** 同意の確認で押すボタン。**「実行」と分ける**（送ることへの同意だと分かるように） */
export const WHOLE_READ_CONSENT_LABEL = "送る";

export function describeWholeReadConsent(consent: WholeReadConsent): string {
  const service = consent.serviceName.trim() || "利用中のAIサービス";
  const calls = Math.max(1, Math.round(consent.calls));
  return [
    `本文がまるごと ${service} へ出ます。`,
    `本文 約${chars(consent.bodyChars)}字を${calls}回に区切って送ります` +
      `（指示と設定資料を含めて 約${chars(consent.totalChars)}字）。`,
    `入力 約${chars(consent.inputTokens)}トークン・出力 最大${chars(consent.maxOutputTokens)}トークン` +
      "（上限寄りの目安。指摘の検証で前後の数行も送ります）。",
    `金額はこの拡張機能には分かりません（${service} の現行料金とモデルで決まります）。`,
    `送ってよければ「${WHOLE_READ_CONSENT_LABEL}」を押してください。` +
      "この確認は毎回出ます（覚えません）。",
  ].join("\n");
}

function chars(value: number): string {
  const whole = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  return whole.toLocaleString("ja-JP");
}
