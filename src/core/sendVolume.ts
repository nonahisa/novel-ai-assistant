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
  /** そのうち本文の字数（同じ本文を2度送るなら、2度ぶん数える） */
  readonly bodyChars: number;
  /**
   * 重ねずに数えた本文の字数。`bodyChars` より小さければ、同じ本文を
   * 2度以上送る回があるので「のべ」と言う。渡さなければ言わない
   */
  readonly distinctBodyChars?: number;
}

/** 1回の呼び出しで送るぶん */
export interface PlannedSend {
  /** 指示・設定資料・本文をすべて含む、送るぶんそのもの */
  readonly chars: number;
  /** そのうち本文の字数 */
  readonly bodyChars: number;
}

/** 送る予定の合計。**確認に出す量は、すべてここから数える** */
export interface PlannedSendTotal extends SendVolume {
  /** AIを呼ぶ回数 */
  readonly calls: number;
}

/**
 * 送る呼び出しを足し合わせる（ノートPCの実機、0.76.1、2026-09-23）。
 *
 * **確認に出す量を、1つの一覧からだけ数えるために置いた。** 矛盾検知を
 * まるごと読むときの同意画面に、同意の文面（本命＋「あとで判明する事実」
 * の2回ぶん）と「送る量」（本命だけ）の**違う数が2つ**並んだ。数える場所が
 * 2つあれば、片方だけが呼び出しの増減に置いていかれる。
 */
export function sumPlannedSends(sends: readonly PlannedSend[]): PlannedSendTotal {
  let totalChars = 0;
  let bodyChars = 0;
  for (const send of sends) {
    totalChars += wholeChars(send.chars);
    bodyChars += wholeChars(send.bodyChars);
  }
  return { totalChars, bodyChars, calls: sends.length };
}

/**
 * 送り終えたあと、**確認で示した量と実際に送った量を並べる**（操作ログ用）。
 *
 * 同意は「この量を送ってよい」への答えなので、送ったあとで合っていたかを
 * 確かめられるようにしておく。示した量は上限寄り（本命が通らなければ
 * 2回目は送らない）なので、下回るのは普通である。**超えたら超えたと言う**
 * ——入り切らずに分け直した（同じ本文を小さく区切って送り直した）ときに起きうる。
 */
export function describeSentAgainstPlanned(params: {
  readonly planned: PlannedSendTotal;
  readonly sentChars: number;
  readonly sentCalls: number;
}): string {
  const planned = wholeChars(params.planned.totalChars);
  const sent = wholeChars(params.sentChars);
  const head =
    `送った量: 約${formatChars(sent)}字（${params.sentCalls}回）／` +
    `確認で示した量: 約${formatChars(planned)}字（${params.planned.calls}回）`;
  if (sent <= planned) return head;
  return (
    `${head}——確認で示した量を約${formatChars(sent - planned)}字超えました` +
    "（入り切らずに分け直して送り直したぶんです）"
  );
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
  // 同じ本文を2度送るなら「のべ」と言う。言わないと、同じ画面に書いた
  // 本文の字数（重ねずに数えたもの）と食い違って見える
  const repeated =
    volume.distinctBodyChars !== undefined &&
    wholeChars(volume.distinctBodyChars) < body;
  const bodyLabel = repeated
    ? `本文 のべ${formatChars(body)}字`
    : `本文 ${formatChars(body)}字`;
  return `${head}（${bodyLabel}＋指示と設定資料 ${formatChars(rest)}字）`;
}

function wholeChars(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function formatChars(value: number): string {
  return value.toLocaleString("ja-JP");
}
