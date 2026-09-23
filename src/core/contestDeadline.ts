import { isDateKey } from "../models/workGoals";

/**
 * 公募の締切の書き方から、日付（YYYY-MM-DD）だけを取り出す（設計書6.3.6.1）。
 *
 * 「2026年9月30日（水）23:59」「2026/10/31」「2026年10月末日」「27:59:59」など、
 * 書き方はばらばらである。**時刻は捨てる**——作品目標の締切は日付しか持たない
 * （`models/workGoals`）。「27:59」は翌日の3時59分のことだが、書かれた日付の
 * まま持つ（締切を早めに見るぶんには、書き損じない）。
 *
 * **年の無い書き方（「毎月20日」）や「随時募集」は読まない。** 推し量って
 * 埋めると、作者はその日付を信じて書く。読めなければ空を返し、作者に入れてもらう。
 *
 * VS Code API には依存しない。
 */

const DATE =
  /(\d{4})\s*(?:年|\/|-|\.)\s*(\d{1,2})\s*(?:月|\/|-|\.)\s*(?:(\d{1,2})\s*日?|(末)\s*日)/gu;

/** 書かれた順に、読めた日付を返す（同じ日付は1つにまとめる） */
export function readDeadlines(text: string | null | undefined): string[] {
  const source = (text ?? "").normalize("NFKC");
  const dates: string[] = [];
  let match: RegExpExecArray | null;
  DATE.lastIndex = 0;
  while ((match = DATE.exec(source)) !== null) {
    const [, year, month, day, endOfMonth] = match;
    const dayNumber = endOfMonth ? lastDayOf(Number(year), Number(month)) : Number(day);
    const key = `${year}-${pad(Number(month))}-${pad(dayNumber)}`;
    if (isDateKey(key) && !dates.includes(key)) dates.push(key);
  }
  return dates;
}

/**
 * これからの締切のうち、いちばん近いもの（今日も含む）。
 * 「第77回：10月26日／第78回：1月27日」のように2つ書かれた募集で、
 * 過ぎた回を選ばないため。すべて過ぎていれば null。
 */
export function upcomingDeadline(
  dates: readonly string[],
  todayKey: string
): string | null {
  const upcoming = dates.filter((date) => date >= todayKey).sort();
  return upcoming[0] ?? null;
}

function lastDayOf(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
