/**
 * 作品ごとの目標（設計書6.3.6）。
 *
 * 執筆量の目標（`novelai.stats.dailyGoal`）はVS Codeの設定に1つしか無く、
 * **登録している全作品で共有していた。** 短編を1本仕上げるのと大長編を
 * 書き続けるのとでは目標が違うし、締切のある作品とそうでない作品も違う。
 *
 * ここは**作者が決めた狙い**であって、書いた実績ではない。
 * 実績（`.aiwriter/stats/<環境名>.json`）は環境ごとに分けているが、
 * 目標は作品に1つでよい。複数の環境で書いても、狙いは同じである。
 *
 * VS Code APIに依存しない。
 */

export interface WorkGoals {
  schemaVersion: string;
  /**
   * 1記事（1話）あたりの目標文字数。
   *
   * 「1話3,000字で書く」という作者の狙いを持つ。
   * 話ごとの文字数一覧で、狙いに対して長い・短いを見るために使う。
   */
  perEpisodeChars: number | null;
  /** 締切のある応募先。無ければ null */
  contest: ContestGoal | null;
}

export interface ContestGoal {
  /** 賞・コンテストの名前 */
  name: string;
  /** 募集要項のURL。作者が確かめ直せるように残す */
  url: string | null;
  /** 締切日（YYYY-MM-DD）。時刻までは持たない */
  deadline: string;
  /** 応募規定の下限字数 */
  minChars: number | null;
  /** 応募規定の上限字数 */
  maxChars: number | null;
  /**
   * 日間の目標字数。
   *
   * **入れなければ残り日数から割り出す。** 作者が自分で決めた値が
   * あるならそちらを優先する（「平日は書けないので土日で稼ぐ」など、
   * 割り算では出ない事情がある）。
   */
  dailyGoal: number | null;
}

export const WORK_GOALS_SCHEMA_VERSION = "0.1";
export const WORK_GOALS_FILE = "goals.json";

export function emptyWorkGoals(): WorkGoals {
  return {
    schemaVersion: WORK_GOALS_SCHEMA_VERSION,
    perEpisodeChars: null,
    contest: null,
  };
}

/**
 * 作者が手で編集したJSONを検証する。
 *
 * **壊れていれば例外を投げる。** 勝手に直して上書きすると、
 * 作者が書いた値が黙って消える。
 */
export function parseWorkGoals(raw: unknown): WorkGoals {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("目標の形式が正しくありません。");
  }
  const value = raw as Record<string, unknown>;

  return {
    schemaVersion:
      typeof value.schemaVersion === "string"
        ? value.schemaVersion
        : WORK_GOALS_SCHEMA_VERSION,
    perEpisodeChars: positiveOrNull(value.perEpisodeChars, "1話あたりの目標"),
    contest: value.contest == null ? null : parseContest(value.contest),
  };
}

function parseContest(raw: unknown): ContestGoal {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("応募先の形式が正しくありません。");
  }
  const value = raw as Record<string, unknown>;

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) throw new Error("応募先の名前がありません。");

  const deadline = typeof value.deadline === "string" ? value.deadline.trim() : "";
  if (!isDateKey(deadline)) {
    throw new Error(`締切日「${deadline}」は YYYY-MM-DD の形で書いてください。`);
  }

  const minChars = positiveOrNull(value.minChars, "下限字数");
  const maxChars = positiveOrNull(value.maxChars, "上限字数");
  // 逆に入っていると、達成率も残り字数も意味を成さない
  if (minChars !== null && maxChars !== null && minChars > maxChars) {
    throw new Error("下限字数が上限字数を超えています。");
  }

  return {
    name,
    url: typeof value.url === "string" && value.url.trim() ? value.url.trim() : null,
    deadline,
    minChars,
    maxChars,
    dailyGoal: positiveOrNull(value.dailyGoal, "日間目標"),
  };
}

function positiveOrNull(raw: unknown, label: string): number | null {
  if (raw == null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`${label}は数値で書いてください。`);
  }
  // 0は「決めていない」と同じ意味にする。負の目標は意味を持たない
  if (raw <= 0) return null;
  return Math.round(raw);
}

/** `YYYY-MM-DD` として読めるか。存在しない日付（2月30日）も弾く */
export function isDateKey(value: string): boolean {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return false;
  const [, year, month, day] = matched;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}
