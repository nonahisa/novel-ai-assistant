import type { Achievement, AchievementKind } from "./celebrations";
import { addDays, monthKey } from "./writingStats";

/**
 * 連続達成（設計書6.3.8、作者の裁定 2026-09-23）。
 *
 * 「日や月など、連続達成のお祝いはちょっと豪華に」への答え。
 *
 * - **1日の目標は連続した日数、1か月の目標は連続した月数**で数える。
 *   目標の値が途中で変わっても、「その日（月）の目標に届いた」が暦の上で
 *   続いていれば連続とする（だから鍵ではなく**日付だけ**を見る）
 * - 2回目から毎回少しずつ風船を増やす（`streakBalloons`。上限あり）
 * - 節目（`isStreakMilestone`）と、**これまでの最長を超えた日**には花火
 * - **途切れても何も言わない。** 次に届いた日から1に戻して数え直すだけ
 *
 * **連続の帳面（`StreakBook`）を別に持つ。** 保存のたびに達成の記録を全部
 * 読み直して数えるのではなく、「最後に届いた日・いまの連続・最長」だけを
 * 覚えておき、新しく届いた日を1つ足して進める。記録は400件で古いほうから
 * 落ちるので、記録から数え直す方式では400日を超える連続を数えられない、
 * という理由もある。帳面が無い（0.78.2以前から上げた）ときだけ、残っている
 * 記録から1度組み直す（`rebuildStreaks`）。
 *
 * VS Code APIに依存しない。
 */

/** 連続を数える種類。作品・締切は1回きりなので連続は無い */
export type StreakKind = "daily" | "monthly";

export interface StreakState {
  /** 最後に届いた単位（1日：YYYY-MM-DD、1か月：YYYY-MM） */
  last: string;
  /** `last` で終わる、いまの連続 */
  current: number;
  /** これまでの最長 */
  best: number;
  /**
   * 最長の連続が最後に伸びた単位。
   *
   * **「最長を超えた」を1度だけ言うために持つ。** 最長を塗り替えている最中の
   * 連続は、毎日「最長を超えて」いる。前の連続を追い抜いた1日だけを祝うには、
   * いまの最長がいまの連続のものか、前の連続のものかを知る必要がある。
   * 並んだだけ（同じ長さ）のときは動かさない——並んだ日ではなく、
   * 超えた日を祝うため。
   */
  bestLast: string;
}

export interface StreakBook {
  daily?: StreakState;
  monthly?: StreakState;
}

export interface StreakStep {
  state: StreakState;
  /** この単位で数えた連続。日付が戻ったときは undefined（何も言わない） */
  streak: number | undefined;
  /** 節目に届いた */
  milestone: boolean;
  /** 前の連続の最長を超えた */
  record: boolean;
}

/**
 * 最長を超えたと言う、前の最長の下限。
 *
 * 前の最長が1（連続したことが無い）なら、2日続いただけで「最長を更新」に
 * なってしまう。初めての連続は、風船が増えることで祝われているので足りる。
 */
const RECORD_MIN_PREVIOUS = 2;

/** 前の月（YYYY-MM）。1月の前は前の年の12月 */
export function previousMonth(month: string): string {
  const [year, value] = month.split("-").map(Number);
  if (value <= 1) return `${year - 1}-12`;
  return `${year}-${String(value - 1).padStart(2, "0")}`;
}

function previousUnit(unit: string, kind: StreakKind): string {
  return kind === "daily" ? addDays(unit, -1) : previousMonth(unit);
}

/**
 * 届いた単位を1つ足して連続を進める。
 *
 * - 同じ単位にもう一度届いた（目標を変えて同じ日に2度届いた）：数は増やさず、
 *   節目も最長も繰り返さない
 * - 日付が戻った（区切りの時刻を変えた、端末の時計が戻った）：帳面を動かさず、
 *   連続も言わない。戻った日で上書きすると、翌日に連続が途切れたことになる
 */
export function advanceStreak(
  state: StreakState | undefined,
  unit: string,
  kind: StreakKind
): StreakStep {
  if (!state) {
    return {
      state: { last: unit, current: 1, best: 1, bestLast: unit },
      streak: 1,
      milestone: isStreakMilestone(kind, 1),
      record: false,
    };
  }
  if (unit === state.last) {
    return { state, streak: state.current, milestone: false, record: false };
  }
  if (unit < state.last) {
    return { state, streak: undefined, milestone: false, record: false };
  }

  const continuing = state.last === previousUnit(unit, kind);
  const current = continuing ? state.current + 1 : 1;
  // 最長がいまの連続のものなら、伸びても「超えた」とは言わない（毎日言うことになる）
  const bestIsCurrent = continuing && state.bestLast === state.last;
  const record =
    current > state.best && state.best >= RECORD_MIN_PREVIOUS && !bestIsCurrent;
  const beaten = current > state.best;
  return {
    state: {
      last: unit,
      current,
      best: beaten ? current : state.best,
      bestLast: beaten ? unit : state.bestLast,
    },
    streak: current,
    milestone: isStreakMilestone(kind, current),
    record,
  };
}

/**
 * 節目。1日は 7・14・30・50・100、以降100日ごと。1か月は 3・6・12、以降12か月ごと
 * （作者の裁定、2026-09-23）。
 */
export function isStreakMilestone(kind: StreakKind, count: number): boolean {
  if (kind === "daily") {
    return [7, 14, 30, 50, 100].includes(count) || (count > 100 && count % 100 === 0);
  }
  return [3, 6, 12].includes(count) || (count > 12 && count % 12 === 0);
}

/**
 * 風船の数。
 *
 * **1日は5個から、2日目から1個ずつ、24個で止める**（20日目で上限）。
 * **1か月は12個から、2か月目から2個ずつ、30個で止める**（10か月目で上限）。
 * 1か月は回数が少ない（1年で12回）ぶん、1回ごとの増え方を大きくした。
 * 上限を設けるのは、増え続けると画面が風船で埋まって札が読めなくなるため。
 * 作品・締切は1回きりなので12個のまま。
 */
export const DAILY_BALLOONS_BASE = 5;
export const DAILY_BALLOONS_MAX = 24;
export const MONTHLY_BALLOONS_BASE = 12;
export const MONTHLY_BALLOONS_STEP = 2;
export const MONTHLY_BALLOONS_MAX = 30;
const ONCE_BALLOONS = 12;

export function streakBalloons(
  kind: AchievementKind,
  streak: number | undefined
): number {
  const extra = Math.max(0, (streak ?? 1) - 1);
  switch (kind) {
    case "daily":
      return Math.min(DAILY_BALLOONS_MAX, DAILY_BALLOONS_BASE + extra);
    case "monthly":
      return Math.min(
        MONTHLY_BALLOONS_MAX,
        MONTHLY_BALLOONS_BASE + extra * MONTHLY_BALLOONS_STEP
      );
    default:
      return ONCE_BALLOONS;
  }
}

function unitOf(entry: Achievement): { kind: StreakKind; unit: string } | undefined {
  if (entry.kind === "daily") return { kind: "daily", unit: entry.day };
  if (entry.kind === "monthly") return { kind: "monthly", unit: monthKey(entry.day) };
  return undefined;
}

/**
 * 新しく届いた達成に、連続・節目・最長の印を書き込み、帳面を進める。
 *
 * **連続が1（初めて、または途切れた次の日）のときは何も書かない。**
 * 祝いも言い方も今までどおりになる。作品・締切の達成は素通しする。
 */
export function applyStreaks(
  found: readonly Achievement[],
  book: StreakBook
): { found: Achievement[]; book: StreakBook } {
  const next: StreakBook = { ...book };
  const annotated = found.map((entry): Achievement => {
    const target = unitOf(entry);
    if (!target) return entry;
    const step = advanceStreak(next[target.kind], target.unit, target.kind);
    next[target.kind] = step.state;
    if (step.streak === undefined || step.streak < 2) return entry;
    const marked: Achievement = { ...entry, streak: step.streak };
    if (step.milestone) marked.streakMilestone = true;
    if (step.record) marked.streakRecord = true;
    return marked;
  });
  return { found: annotated, book: next };
}

/**
 * 残っている達成の記録から帳面を組み直す。帳面が無い・読めないときだけ使う。
 *
 * 同じ日（月）の達成が2つ以上ある（目標を変えた）ときは1つと数える。
 * 記録の並びは信用せず、日付順に並べ直してから数える。
 */
export function rebuildStreaks(records: readonly Achievement[]): StreakBook {
  const units: Record<StreakKind, Set<string>> = {
    daily: new Set(),
    monthly: new Set(),
  };
  for (const entry of records) {
    const target = unitOf(entry);
    if (target) units[target.kind].add(target.unit);
  }
  const book: StreakBook = {};
  for (const kind of ["daily", "monthly"] as const) {
    let state: StreakState | undefined;
    for (const unit of [...units[kind]].sort()) {
      state = advanceStreak(state, unit, kind).state;
    }
    if (state) book[kind] = state;
  }
  return book;
}

/**
 * 保存してあった帳面を読む。**形が崩れていれば undefined**——呼び出し側が
 * 記録から組み直す（globalState は拡張機能だけが書くので、崩れていても
 * 作者の書いたものを消すことにはならない）。
 */
export function streakBookOf(raw: unknown): StreakBook | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const book: StreakBook = {};
  for (const kind of ["daily", "monthly"] as const) {
    if (value[kind] === undefined) continue;
    const state = streakStateOf(value[kind]);
    if (!state) return undefined;
    book[kind] = state;
  }
  return book;
}

function streakStateOf(raw: unknown): StreakState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.last !== "string" ||
    typeof value.bestLast !== "string" ||
    typeof value.current !== "number" ||
    typeof value.best !== "number" ||
    !(value.current >= 1) ||
    !(value.best >= value.current)
  ) {
    return undefined;
  }
  return {
    last: value.last,
    current: value.current,
    best: value.best,
    bestLast: value.bestLast,
  };
}
