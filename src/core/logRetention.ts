/**
 * ログの自動削除（設計書8.3）。
 *
 * 作者の要望。**既定は7日。**
 *
 * ログには**原稿の一部が入る**（相談のログ、抽出の失敗の応答）。
 * 際限なく残しておく理由は無く、置きっぱなしにするほど
 * 何が入っているか分からなくなる。
 *
 * **消すのは古い行だけで、ファイルは残す。** ファイルごと消すと、
 * 書いている最中のログまで巻き込む。1行ずつ日時を見て切り分ける。
 *
 * **日時が読めない行は残す。** 複数行にわたる応答の中身や、
 * こちらが書いていない行が混ざりうる。読めないものを消す判断はしない。
 * ただし**先頭に日時のある行が1つも無いファイルには触れない**
 * （形が違う＝この仕組みが想定していないファイル）。
 *
 * VS Code APIに依存しない。
 */

/** ログの日時の形（`formatLogTime`）。`[2026-08-16 20:42:28]` と JSONL の両方 */
const BRACKET_TIME = /^\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\]/;
const JSON_TIME = /^\{"timestamp":"(\d{4}-\d{2}-\d{2}) /;
/** 相談のログ（Markdown）の見出し。`## 2026-08-16 20:42:28` */
const HEADING_TIME = /^#{1,6} (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}/;

/** その行が持つ日付（`YYYY-MM-DD`）。読めなければ undefined */
export function logLineDate(line: string): string | undefined {
  for (const pattern of [BRACKET_TIME, JSON_TIME, HEADING_TIME]) {
    const matched = pattern.exec(line);
    if (matched) return matched[1];
  }
  return undefined;
}

/** `todayKey` から `days` 日前の日付。これより古い行を消す */
export function cutoffDate(todayKey: string, days: number): string {
  const at = Date.parse(`${todayKey}T00:00:00Z`) - days * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

export interface PruneResult {
  text: string;
  /** 消した行数 */
  removed: number;
  /** 中身が変わったか。変わっていなければ書き戻さない */
  changed: boolean;
}

/**
 * 古い行を落とす。
 *
 * @param days 残す日数。0以下なら何もしない（「消さない」設定）
 * @param todayKey 今日（`YYYY-MM-DD`）
 */
export function pruneLogText(
  text: string,
  days: number,
  todayKey: string
): PruneResult {
  if (days <= 0 || !text) return { text, removed: 0, changed: false };

  const lines = text.split("\n");
  // 日時のある行が1つも無いファイルは、この仕組みの対象ではない
  if (!lines.some((line) => logLineDate(line) !== undefined)) {
    return { text, removed: 0, changed: false };
  }

  const cutoff = cutoffDate(todayKey, days);
  const kept: string[] = [];
  let removed = 0;
  /**
   * 直前に見た日時つきの行が、消す対象だったか。
   *
   * **日時の無い行は、直前の行に付いていく。** 相談のログは
   * 見出しの下に本文が続く形で、見出しだけ消すと中身が浮く。
   */
  let dropping = false;

  for (const line of lines) {
    const date = logLineDate(line);
    if (date !== undefined) {
      dropping = date < cutoff;
      if (dropping) {
        removed++;
        continue;
      }
      kept.push(line);
      continue;
    }
    if (dropping) {
      removed++;
      continue;
    }
    kept.push(line);
  }

  const next = kept.join("\n");
  return { text: next, removed, changed: next !== text };
}
