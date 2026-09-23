import type { ContestGoal } from "../models/workGoals";
import { readCharLimit } from "./contestCharLimit";
import { daysUntil } from "./contestProgress";
import { readDeadlines, upcomingDeadline } from "./contestDeadline";
import type { ContestListing, ContestSource } from "./contestListing";

/**
 * 取り込んだ公募の置き場と、選ぶ画面の並び（設計書6.3.6.1）。
 *
 * ## 作品に紐づけない
 *
 * 公募の一覧は作品ごとのものではない（1つの一覧から、作品Aの応募先も作品Bの
 * 応募先も選べる）。だから取り込んだ一覧は**この端末の置き場**（`globalState`）に
 * 持ち、作品へは**応募先に選んだ1件だけ**を `goals.json` に書く——これまでの
 * 応募先と同じ形で、同期される作品フォルダに他人の文章を積まない。
 *
 * ## 置き場に持つもの
 *
 * 画面に出す要所（名前・締切・賞典・字数・主催・募集作品・応募資格…の原文）と、
 * 取り込んだ日時・読んだページ。**読み替えた数（締切の日付・字数）は持たない**
 * ——読み戻すたびに原文から読み直す（読み取りを直した日に、古い読みが残らない）。
 *
 * VS Code API には依存しない。
 */

/** 置き場に持つ件数の上限（新しいものを残す） */
export const CONTEST_INBOX_LIMIT = 600;

export interface StoredContest extends ContestListing {
  /** 取り込んだ日時（ISO 8601） */
  readonly importedAt: string;
  /** 読んだ一覧のページ（http・https）。貼り付けた文には無い */
  readonly sourcePage: string | null;
}

/** 読み取った公募に、取り込んだ日時と読んだページを添える */
export function storeContests(
  listings: readonly ContestListing[],
  meta: { importedAt: string; sourcePage: string | null }
): StoredContest[] {
  return listings.map((listing) => ({ ...listing, ...meta }));
}

/** 名前の比べ方：全角半角を揃え、空白を除く */
function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

/**
 * 同じ公募か。**名前で比べ、主催が両方分かっていれば主催も比べる。**
 *
 * 名前だけだと「第1回 短編小説賞」のような、主催の違う募集を取り違える。
 * 主催まで必須にすると、主催の欄が無い一覧（ツクリテミライ）や手で入れた
 * 応募先と、同じ公募を突き合わせられなくなる。
 */
export function sameContest(
  a: { name: string; organizer: string | null },
  b: { name: string; organizer: string | null }
): boolean {
  if (nameKey(a.name) !== nameKey(b.name)) return false;
  if (a.organizer && b.organizer) return nameKey(a.organizer) === nameKey(b.organizer);
  return true;
}

/** 締切がすべて過ぎたか（締切を読めないものは過ぎたと言わない） */
function isPast(contest: ContestListing, todayKey: string): boolean {
  return contest.deadlines.length > 0 && upcomingDeadline(contest.deadlines, todayKey) === null;
}

/**
 * 取り込んだ分を置き場へ足す。**同じ公募は新しいもので置き換える**（取り込み直しで
 * 二重にならない）。締切の過ぎたものは置かない。
 */
export function mergeContestInbox(
  existing: readonly StoredContest[],
  incoming: readonly StoredContest[],
  todayKey: string
): { inbox: StoredContest[]; added: number; updated: number; droppedPast: number } {
  let added = 0;
  let updated = 0;
  let droppedPast = 0;
  const fresh: StoredContest[] = [];
  for (const contest of incoming) {
    if (isPast(contest, todayKey)) {
      droppedPast++;
      continue;
    }
    // 同じ一覧の中で同じ公募が2度出たら（見出しの違う2か所に載っている）、1つにする
    if (fresh.some((other) => sameContest(other, contest))) continue;
    fresh.push(contest);
    if (existing.some((other) => sameContest(other, contest))) updated++;
    else added++;
  }
  const kept = existing.filter(
    (contest) =>
      !isPast(contest, todayKey) && !fresh.some((other) => sameContest(other, contest))
  );
  return {
    inbox: [...fresh, ...kept].slice(0, CONTEST_INBOX_LIMIT),
    added,
    updated,
    droppedPast,
  };
}

const SOURCES: readonly ContestSource[] = ["novelportal", "tsukuritemirai", "pasted"];

/**
 * 置き場から読み戻す。**形の合わない項目は捨てる**（置き場は拡張機能の中の
 * 覚え書きで、作者が書いたデータではない。捨てても一覧を取り込み直せば戻る）。
 * 締切の日付と字数は原文から読み直す。
 */
export function normalizeContestInbox(raw: unknown): StoredContest[] {
  if (!Array.isArray(raw)) return [];
  const result: StoredContest[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.name !== "string" || !value.name.trim()) continue;
    if (typeof value.importedAt !== "string" || Number.isNaN(Date.parse(value.importedAt))) {
      continue;
    }
    const source = SOURCES.includes(value.source as ContestSource)
      ? (value.source as ContestSource)
      : "pasted";
    const text = (field: unknown): string | null =>
      typeof field === "string" && field.trim() ? field : null;
    const link = (field: unknown): string | null => {
      const candidate = text(field);
      return candidate && /^https?:\/\/\S+$/u.test(candidate) ? candidate : null;
    };
    const deadlineText = text(value.deadlineText);
    const charText = text(value.charText);
    result.push({
      name: value.name,
      url: link(value.url),
      section: text(value.section),
      source,
      deadlineText,
      deadlines: readDeadlines(deadlineText),
      prize: text(value.prize),
      charText,
      organizer: text(value.organizer),
      judges: text(value.judges),
      genre: text(value.genre),
      eligibility: text(value.eligibility),
      fee: text(value.fee),
      charLimit: readCharLimit(charText),
      importedAt: value.importedAt,
      sourcePage: link(value.sourcePage),
    });
  }
  return result.slice(0, CONTEST_INBOX_LIMIT);
}

// ---------------------------------------------------------------------------
// 選ぶ画面の並び
// ---------------------------------------------------------------------------

/**
 * 作品のいまの字数に合うか。
 *
 * - fits：いまの字数で応募できる（下限に届いていて、上限を超えていない。制限なしも）
 * - reachable：下限に届いていないが、締切までに1日の目安の字数で届く
 * - unknownChars：字数を読めなかった（原文を見て作者が決める）
 * - far：下限まで、1日の目安では届かない
 * - over：いまの字数が上限を超えている
 * - noDeadline：締切を読めなかった（随時募集など）
 */
export type ContestFit = "fits" | "reachable" | "unknownChars" | "far" | "over" | "noDeadline";

const FIT_ORDER: readonly ContestFit[] = [
  "fits",
  "reachable",
  "unknownChars",
  "far",
  "over",
  "noDeadline",
];

export interface RankedContest {
  readonly contest: StoredContest;
  /** これからの締切（読めなければ null） */
  readonly deadline: string | null;
  /** 締切までの日数（当日を1日と数える）。締切が無ければ null */
  readonly daysLeft: number | null;
  readonly fit: ContestFit;
  /** 下限に届くまでの1日あたりの字数（下限に届いていないときだけ） */
  readonly neededPerDay: number | null;
}

/**
 * 選ぶ画面に並べる順。**字数に合うものを上に、その中は締切の近い順。**
 * 締切の過ぎたものは出さない。締切を読めないものは最後にまとめる。
 *
 * @param pacePerDay 「届きそう」とみなす1日の字数（作者の1日の目標。無ければ目安）
 */
export function rankContests(
  inbox: readonly StoredContest[],
  options: { written: number; todayKey: string; pacePerDay: number }
): RankedContest[] {
  const ranked: RankedContest[] = [];
  for (const contest of inbox) {
    const deadline = upcomingDeadline(contest.deadlines, options.todayKey);
    if (contest.deadlines.length > 0 && deadline === null) continue;
    const daysLeft = deadline === null ? null : daysUntil(deadline, options.todayKey);
    const { fit, neededPerDay } = fitOf(contest, options.written, daysLeft, options.pacePerDay);
    ranked.push({
      contest,
      deadline,
      daysLeft,
      fit: deadline === null ? "noDeadline" : fit,
      neededPerDay,
    });
  }
  return ranked.sort(
    (a, b) =>
      FIT_ORDER.indexOf(a.fit) - FIT_ORDER.indexOf(b.fit) ||
      (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") ||
      a.contest.name.localeCompare(b.contest.name, "ja")
  );
}

function fitOf(
  contest: StoredContest,
  written: number,
  daysLeft: number | null,
  pacePerDay: number
): { fit: ContestFit; neededPerDay: number | null } {
  const limit = contest.charLimit;
  if (limit.kind === "none") return { fit: "fits", neededPerDay: null };
  if (limit.kind === "unreadable") return { fit: "unknownChars", neededPerDay: null };
  if (limit.max !== null && written > limit.max) return { fit: "over", neededPerDay: null };
  if (limit.min === null || written >= limit.min) return { fit: "fits", neededPerDay: null };
  const needed = limit.min - written;
  if (daysLeft === null || daysLeft <= 0) return { fit: "far", neededPerDay: null };
  const perDay = Math.ceil(needed / daysLeft);
  return { fit: perDay <= pacePerDay ? "reachable" : "far", neededPerDay: perDay };
}

// ---------------------------------------------------------------------------
// 応募先へ入れる・取り込み直したときの違い
// ---------------------------------------------------------------------------

/**
 * 選んだ公募を、作品の応募先の形にする。締切・下限・上限は作者が確かめた値を渡す
 * （読めなかったものは作者が入れる）。
 *
 * リンクは**公式の募集要項**（一覧に載っていたリンク）。無ければ読んだ一覧のページ。
 */
export function goalFromContest(
  contest: StoredContest,
  values: { deadline: string; minChars: number | null; maxChars: number | null }
): ContestGoal {
  return {
    name: contest.name,
    url: contest.url ?? contest.sourcePage,
    deadline: values.deadline,
    minChars: values.minChars,
    maxChars: values.maxChars,
    dailyGoal: null,
    imported: {
      importedAt: contest.importedAt,
      sourcePage: contest.sourcePage,
      organizer: contest.organizer,
      deadlineText: contest.deadlineText,
      charText: contest.charText,
    },
  };
}

export interface ContestChange {
  readonly field: "deadline" | "minChars" | "maxChars";
  readonly before: string | number | null;
  readonly after: string | number | null;
}

/**
 * 作品の応募先と、取り込み直した公募の違い。**別の公募なら null**、同じで違いが
 * 無ければ空。
 *
 * **読めなかったものは比べない**（締切を読めない・字数を読めない）。推し量った値との
 * 違いを知らせると、作者が確かめて入れた値を、読み違いで書き換えさせることになる。
 */
export function contestChanges(
  goal: ContestGoal,
  contest: StoredContest,
  todayKey: string
): ContestChange[] | null {
  if (!sameContest({ name: goal.name, organizer: goal.imported?.organizer ?? null }, contest)) {
    return null;
  }
  const changes: ContestChange[] = [];
  const deadline =
    upcomingDeadline(contest.deadlines, todayKey) ??
    [...contest.deadlines].sort().pop() ??
    null;
  if (deadline !== null && deadline !== goal.deadline) {
    changes.push({ field: "deadline", before: goal.deadline, after: deadline });
  }
  const limit = contest.charLimit;
  if (limit.kind !== "unreadable") {
    const min = limit.kind === "range" ? limit.min : null;
    const max = limit.kind === "range" ? limit.max : null;
    if (min !== goal.minChars) changes.push({ field: "minChars", before: goal.minChars, after: min });
    if (max !== goal.maxChars) changes.push({ field: "maxChars", before: goal.maxChars, after: max });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// 画面に出す言い方
// ---------------------------------------------------------------------------

/**
 * いつの情報か（「9月23日時点の情報」）。**募集は書き換わる**ので、応募先の表示に添える。
 * 日付は取り込んだ日時の文字の日付をそのまま使う（時差つきで書いてあるので、
 * 読み直した端末の時差でずれない）。
 */
export function asOfLabel(importedAt: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/u.exec(importedAt);
  if (!match) return "取り込んだ日の分からない情報";
  return `${Number(match[2])}月${Number(match[3])}日時点の情報`;
}

/** 字数の読みを短く言う（選ぶ画面・確かめる画面） */
export function charLimitSummary(limit: ContestListing["charLimit"]): string {
  if (limit.kind === "none") return "字数の制限なし";
  if (limit.kind === "unreadable") return "字数を読めませんでした";
  const count = (value: number) => value.toLocaleString("ja-JP");
  const range =
    limit.min !== null && limit.max !== null
      ? `${count(limit.min)}〜${count(limit.max)}字`
      : limit.min !== null
        ? `${count(limit.min)}字以上`
        : `${count(limit.max ?? 0)}字以内`;
  return limit.converted ? `${range}（原稿用紙換算）` : range;
}

/**
 * その土地の時差つきの日時（「2026-09-23T10:00:00.000+09:00」）。
 * `toISOString()` は世界時で書くので、夜中に取り込むと日付が1日ずれて見える。
 */
export function localIsoString(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
