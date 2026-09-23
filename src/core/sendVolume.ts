/**
 * 押す前の確認に出す「送る量」（作者の裁定、2026-09-23。A3①）。
 *
 * ## なぜ本文の字数だけでは足りないか
 *
 * 矛盾検知は本文と一緒に**設定資料（人物・場所・世界観・あらすじ）**を送る。
 * 前の話から人物を引き継ぐ（`carryOver`。0.73.3 で既定2話）と、1回に送る
 * 量はおよそ**＋16%**になる（実測、設計書6.10.6）。確認画面の目安が本文の
 * 字数だけを見ていると、この増えたぶんが時間の見込みにも量の表示にも
 * 出てこない——**送る量が増えることを黙らない**（設計書6.74）の約束が
 * 守れない。
 *
 * ここは言い方だけを持つ。数えるのは呼ぶ側（実際に送るプロンプトを組んで
 * 字数を取る）で、**見込みの定数を置かない**——プロンプトの改訂に置いて
 * いかれて必ず外れる。
 *
 * VS Code API に依存しない。
 */

export interface SendVolume {
  /** 送る字数の合計（指示・設定資料・本文をすべて含む、送るぶんそのもの） */
  readonly totalChars: number;
  /** そのうち本文の字数 */
  readonly bodyChars: number;
}

/**
 * 「送る量: 約12,345字（本文 10,000字＋指示と設定資料 2,345字）」。
 *
 * **本文以外が0なら内訳を出さない**（言うことが無い）。合計が本文より
 * 小さいとき（数え方の食い違い）も内訳を出さない——負の字数を見せない。
 */
export function describeSendVolume(volume: SendVolume): string {
  const total = wholeChars(volume.totalChars);
  const body = wholeChars(volume.bodyChars);
  const rest = total - body;
  const head = `送る量: 約${formatChars(total)}字`;
  if (rest <= 0) return head;
  return `${head}（本文 ${formatChars(body)}字＋指示と設定資料 ${formatChars(rest)}字）`;
}

function wholeChars(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function formatChars(value: number): string {
  return value.toLocaleString("ja-JP");
}
