import type { WorkGoals } from "../models/workGoals";
import { daysUntil, targetCharsOf } from "./contestProgress";
import { addDays, monthKey } from "./writingStats";

/**
 * 目標の達成を祝う（設計書6.3.8）。
 *
 * 祝う目標は4つある。
 *
 * | 種類 | 何に届いたか | 一度きりの単位 |
 * |---|---|---|
 * | `daily` | 1日の目標字数（設定。全作品で共有） | 日＋目標値 |
 * | `monthly` | 1か月の目標字数（設定。全作品で共有） | 月＋目標値 |
 * | `work` | 作品の文字量（「この作品の目標」の応募先の字数） | 作品＋目標値 |
 * | `deadline` | 締切より前に作品の文字量へ届いた | 作品＋応募先＋締切＋目標値 |
 *
 * **一度きりがいちばん大事なところである。** 保存のたびに風船が上がれば、
 * 祝いではなく邪魔になる。一方で目標を変えたら、新しい値に届いたときには
 * 改めて祝ってよい——だから鍵に**目標値を含める。**
 *
 * **書いて増えた保存のときだけ祝う。** 投稿サイトから取り込んだ本文や、
 * 削った保存で「届いた」ことにしない。書いた手で届いたときが祝う時である。
 *
 * VS Code APIに依存しない。判定はすべてここで行い、試験で確かめる。
 */

export type AchievementKind = "daily" | "monthly" | "work" | "deadline";

const KINDS: readonly AchievementKind[] = ["daily", "monthly", "work", "deadline"];

export interface Achievement {
  /** 一度きりを決める鍵。同じ鍵は二度祝わない */
  id: string;
  kind: AchievementKind;
  /** 届いた日（執筆量と同じ日付の区切り。YYYY-MM-DD） */
  day: string;
  /** 届いた時刻（ISO） */
  at: string;
  /** 届いた目標の字数 */
  goal: number;
  /** 届いたときの字数（1日・1月は全作品の合計、作品は作品の字数） */
  written: number;
  /** 作品の目標のときだけ持つ */
  workId?: string;
  workTitle?: string;
  contestName?: string;
  deadline?: string;
}

export function dailyAchievementId(day: string, goal: number): string {
  return `daily:${day}:${goal}`;
}

export function monthlyAchievementId(month: string, goal: number): string {
  return `monthly:${month}:${goal}`;
}

export function workAchievementId(workId: string, target: number): string {
  return `work:${workId}:${target}`;
}

export function deadlineAchievementId(
  workId: string,
  contestName: string,
  deadline: string,
  target: number
): string {
  return `deadline:${workId}:${contestName}|${deadline}:${target}`;
}

export interface AchievementJudgeInput {
  at: Date;
  /** 今日（執筆量と同じ区切りで数えた日付） */
  day: string;
  /** この保存で字数が増えたか。増えていなければ何も祝わない */
  wrote: boolean;
  /** 1日の目標。0 は未設定 */
  dailyGoal: number;
  /** 全作品の今日の合計。読めなかったら undefined */
  todayTotal?: number;
  /** 1か月の目標。0 は未設定 */
  monthlyGoal: number;
  /** 全作品の今月の合計。読めなかったら undefined */
  monthTotal?: number;
  /** 保存した作品。作品の目標を見るときだけ渡す */
  work?: { id: string; title: string; goals: WorkGoals; written: number };
  /** すでに祝った鍵 */
  known: ReadonlySet<string>;
}

/** この保存で新しく届いた目標を返す。無ければ空 */
export function judgeAchievements(input: AchievementJudgeInput): Achievement[] {
  if (!input.wrote) return [];
  const at = input.at.toISOString();
  const found: Achievement[] = [];

  const daily = positive(input.dailyGoal);
  if (daily && input.todayTotal !== undefined && input.todayTotal >= daily) {
    const id = dailyAchievementId(input.day, daily);
    if (!input.known.has(id)) {
      found.push({ id, kind: "daily", day: input.day, at, goal: daily, written: input.todayTotal });
    }
  }

  const monthly = positive(input.monthlyGoal);
  if (monthly && input.monthTotal !== undefined && input.monthTotal >= monthly) {
    const id = monthlyAchievementId(monthKey(input.day), monthly);
    if (!input.known.has(id)) {
      found.push({ id, kind: "monthly", day: input.day, at, goal: monthly, written: input.monthTotal });
    }
  }

  const work = input.work;
  const contest = work?.goals.contest;
  if (work && contest) {
    const target = targetCharsOf(contest);
    /*
      **上限を超えているときは祝わない。** 応募規定を外れていて、執筆量パネルは
      「削る必要があります」と言っている。そこへ風船を上げると、言っていることが
      食い違う。
    */
    const overMax = contest.maxChars !== null && work.written > contest.maxChars;
    if (target !== null && work.written >= target && !overMax) {
      const base = {
        day: input.day,
        at,
        goal: target,
        written: work.written,
        workId: work.id,
        workTitle: work.title,
      };
      const workId = workAchievementId(work.id, target);
      if (!input.known.has(workId)) {
        found.push({ ...base, id: workId, kind: "work" });
      }
      // 締切当日も「締切より前」に入れる（当日いっぱい書ける。contestProgress と同じ数え方）
      if (daysUntil(contest.deadline, input.day) > 0) {
        const deadlineId = deadlineAchievementId(
          work.id,
          contest.name,
          contest.deadline,
          target
        );
        if (!input.known.has(deadlineId)) {
          found.push({
            ...base,
            id: deadlineId,
            kind: "deadline",
            contestName: contest.name,
            deadline: contest.deadline,
          });
        }
      }
    }
  }

  return found;
}

function positive(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * どれだけ賑やかに祝うか。
 *
 * **1日の目標は少なめ。** 毎日のことなので、毎回大騒ぎすると慣れて
 * 嬉しくなくなる。作品と締切は作品1本に1回きりの大きな節目なので、花火も上げる。
 */
export type CelebrationSize = "small" | "balloons" | "fireworks";

export function celebrationSize(
  kinds: readonly AchievementKind[]
): CelebrationSize | undefined {
  if (kinds.includes("work") || kinds.includes("deadline")) return "fireworks";
  if (kinds.includes("monthly")) return "balloons";
  if (kinds.includes("daily")) return "small";
  return undefined;
}

/** 大きい順。下の欄に1つだけ出すとき、どれを選ぶかに使う */
const WEIGHT: Record<AchievementKind, number> = {
  daily: 1,
  monthly: 2,
  work: 3,
  deadline: 4,
};

const CHEER: Record<AchievementKind, string> = {
  daily: "今日の目標に届きました",
  monthly: "今月の目標に届きました",
  work: "作品の目標の字数に届きました",
  deadline: "締切より前に書き上げました",
};

/**
 * 原稿エディターの下の欄に出す一言。
 *
 * **その日の間だけ出す。** 書いている最中に画面を動かさないよう、ここは
 * 字数の隣に文字で添えるだけにしている。日が替われば出ない。
 * 今日の達成が複数あれば、いちばん大きいものを1つだけ言う。
 */
export function footCheer(
  records: readonly Achievement[],
  today: string,
  workId: string | undefined
): string | undefined {
  let best: Achievement | undefined;
  for (const entry of records) {
    if (entry.day !== today) continue;
    // 作品の達成は、その作品の原稿でだけ言う
    if (entry.workId !== undefined && entry.workId !== workId) continue;
    if (!best || WEIGHT[entry.kind] > WEIGHT[best.kind]) best = entry;
  }
  return best ? CHEER[best.kind] : undefined;
}

/**
 * 執筆統計を開いたときに、あとから風船を上げる達成の範囲（日数）。
 *
 * **閉じていたら次に開いたときに一度だけ**上げるが、ひと月前の1日の目標で
 * 今さら風船が上がっても、何のことか分からない。記録（達成の印）は残るので、
 * 古いものは印だけにする。
 */
export const ACHIEVEMENT_WINDOW_DAYS = 14;

export function pendingCelebrations(
  records: readonly Achievement[],
  shown: ReadonlySet<string>,
  today: string
): Achievement[] {
  const oldest = addDays(today, -ACHIEVEMENT_WINDOW_DAYS);
  return records.filter(
    (entry) => !shown.has(entry.id) && entry.day >= oldest
  );
}

/** 記録に持つ件数の上限。毎日届けば1年で365件になる */
export const ACHIEVEMENT_LOG_LIMIT = 400;

/**
 * 記録へ足す。**同じ鍵は足さない**（最初に届いた時の記録を残す）。
 * 上限を超えたら古いほうから落とす。
 */
export function appendAchievements(
  existing: readonly Achievement[],
  added: readonly Achievement[],
  limit: number = ACHIEVEMENT_LOG_LIMIT
): Achievement[] {
  const seen = new Set(existing.map((entry) => entry.id));
  const merged = [...existing];
  for (const entry of added) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

export const ACHIEVEMENT_LOG_SCHEMA_VERSION = "0.1";

/**
 * 記録を読む。
 *
 * **形が壊れていれば例外にする**（競合マーカーが混ざった、など）。呼び出し側は
 * その作品では祝わず、記録にも書かない——直して上書きすると、残っていた
 * 達成の印が黙って消える。
 *
 * 知らない種類の行（先の版が足したもの）は読み飛ばす。止めるほどのことではない。
 */
export function parseAchievementLog(raw: unknown): Achievement[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("達成の記録の形式が正しくありません。");
  }
  const list = (raw as { achievements?: unknown }).achievements;
  if (!Array.isArray(list)) {
    throw new Error("達成の記録の形式が正しくありません。");
  }
  return list.flatMap((item): Achievement[] => {
    const entry = toAchievement(item);
    return entry ? [entry] : [];
  });
}

/** globalState のように、作者の手が入らない保存先から読むときに使う（壊れた行は捨てる） */
export function toAchievements(raw: unknown): Achievement[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): Achievement[] => {
    const entry = toAchievement(item);
    return entry ? [entry] : [];
  });
}

function toAchievement(item: unknown): Achievement | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const value = item as Record<string, unknown>;
  const kind = value.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.day !== "string" ||
    typeof value.at !== "string" ||
    typeof value.goal !== "number" ||
    typeof value.written !== "number"
  ) {
    return undefined;
  }
  const entry: Achievement = {
    id: value.id,
    kind: kind as AchievementKind,
    day: value.day,
    at: value.at,
    goal: value.goal,
    written: value.written,
  };
  for (const key of ["workId", "workTitle", "contestName", "deadline"] as const) {
    const text = value[key];
    if (typeof text === "string") entry[key] = text;
  }
  return entry;
}

/** 執筆統計の「達成の記録」に出す言い方 */
export function describeAchievement(entry: Achievement): string {
  const chars = `${entry.goal.toLocaleString("ja-JP")}字`;
  switch (entry.kind) {
    case "daily":
      return `1日の目標（${chars}）`;
    case "monthly": {
      const [year, month] = monthKey(entry.day).split("-");
      return `${year}年${Number(month)}月の目標（${chars}）`;
    }
    case "work":
      return `「${entry.workTitle ?? ""}」作品の文字量（${chars}）`;
    case "deadline":
      return (
        `「${entry.workTitle ?? ""}」を${entry.contestName ?? "応募先"}の締切` +
        `（${entry.deadline ?? ""}）より前に書き上げ`
      );
  }
}
