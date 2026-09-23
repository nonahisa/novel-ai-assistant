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
 * ## 送る量は1系統だけ言う（ノートPCの実機、0.76.1、2026-09-23）
 *
 * 同意の文面が自分で「指示と設定資料を含めて 約127,986字」と足し、確認の
 * 本体は「送る量: 約63,420字」と言っていた。**同じ画面に違う数が2つ**
 * 並び、どちらに同意したのか分からない。いまは送る量を受け取るだけにし、
 * 足し合わせは呼ぶ側の1つの一覧（`sumPlannedSends`）に任せる。
 *
 * サービス名は呼ぶ側がプロバイダの表示名を渡す（規則5：決め打ちしない）。
 *
 * VS Code API に依存しない。
 */

import { describeSendVolume, type PlannedSendTotal } from "./sendVolume";

export interface WholeReadConsent {
  /** 送り先の表示名（プロバイダの `displayName`） */
  readonly serviceName: string;
  /** 本文の字数（重ねずに数えたもの） */
  readonly bodyChars: number;
  /** 本文を何回に区切るか */
  readonly pieces: number;
  /**
   * 送る量。**全呼び出しの合計**（`sumPlannedSends` の結果）で、確認画面の
   * 時間の見積もりと同じ一覧から数えたもの。**ここで足し直さない**
   */
  readonly volume: PlannedSendTotal;
  /** 1字あたりのトークン数（入力のトークン数を `volume` から出すのに使う） */
  readonly tokensPerChar: number;
  /** 1回の呼び出しで書ける出力のトークン数の上限 */
  readonly maxOutputTokensPerCall: number;
}

/** 同意の確認で押すボタン。**「実行」と分ける**（送ることへの同意だと分かるように） */
export const WHOLE_READ_CONSENT_LABEL = "送る";

export function describeWholeReadConsent(consent: WholeReadConsent): string {
  const service = consent.serviceName.trim() || "利用中のAIサービス";
  const pieces = Math.max(1, Math.round(consent.pieces));
  const calls = wholeNumber(consent.volume.calls);
  // **入力も出力も、送る量と同じ回数・同じ合計から出す**（言う数を1系統にする）
  const inputTokens = Math.ceil(
    wholeNumber(consent.volume.totalChars) * positive(consent.tokensPerChar)
  );
  const maxOutputTokens = wholeNumber(consent.maxOutputTokensPerCall) * calls;
  return [
    `本文がまるごと ${service} へ出ます。`,
    `本文 約${chars(consent.bodyChars)}字を${pieces}回に区切って送ります。` +
      // 「あとで判明する事実」との突き合わせ（設計書6.10.4）は、同じ本文を
      // もう一度送る。黙ると、下の量が本文の倍近くある理由が分からない
      (calls > pieces
        ? "あとで判明する事実と突き合わせるため、同じ本文をもう一度送ります" +
          `（AIを呼ぶのは全部で${calls}回）。`
        : ""),
    `${describeSendVolume({
      ...consent.volume,
      distinctBodyChars: consent.bodyChars,
    })}。`,
    `入力 約${chars(inputTokens)}トークン・出力 最大${chars(maxOutputTokens)}トークン` +
      "（上限寄りの目安。指摘の検証で前後の数行も送ります）。",
    `金額はこの拡張機能には分かりません（${service} の現行料金とモデルで決まります）。`,
    `送ってよければ「${WHOLE_READ_CONSENT_LABEL}」を押してください。` +
      "この確認は毎回出ます（覚えません）。",
  ].join("\n");
}

function wholeNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function chars(value: number): string {
  return wholeNumber(value).toLocaleString("ja-JP");
}
