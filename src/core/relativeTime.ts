import type { RelativeTime, TimePart } from "../models/storyFact";

/**
 * 作中の時刻を、暦ではなく**物語の起点からの相対**で読む（設計書6.88.4）。
 *
 * 作者の裁定（2026-09-11）。小説は「何年何月何日」を書かないことのほうが
 * 多く、書いてあっても架空の暦であることがある。**暦に直そうとすると、
 * 直せない作品では機能が丸ごと使えなくなる。** 起点からの日数と
 * 朝・昼・夕・夜だけなら、たいていの作品から読める。
 *
 * **読めなければ `null` にして、推測で埋めない**（6.2.1 の話数と同じ考え方）。
 * 推測で埋めた時刻で矛盾を出すと、作者は本文ではなくこちらの推測を
 * 直しに行くことになる。
 *
 * VS Code APIに依存しない。
 */

/** 一日の区分の順番。`part` が `null` のときは「その日のいつか」で順序不明 */
const PART_ORDER: Record<TimePart, number> = { 朝: 1, 昼: 2, 夕: 3, 夜: 4 };

/**
 * 言い回しを4つの区分へ寄せる。
 *
 * **長い語を先に置く。** 「夜中」を「夜」より後ろに置くと、先頭一致で
 * 「夜」が当たってしまい、区分を増やしたときに読み違える。
 */
const PART_ALIASES: ReadonlyArray<readonly [string, TimePart]> = [
  ["早朝", "朝"],
  ["夜中", "夜"],
  ["深夜", "夜"],
  ["夕方", "夕"],
  ["朝", "朝"],
  ["昼", "昼"],
  ["夕", "夕"],
  ["夜", "夜"],
];

/** `day+14 夕` 形式 */
const DAY_LABEL = /^day\s*([+-]?\d+)/i;
/** `14日目 夕`・`3日目の夜` 形式 */
const DAY_JAPANESE = /^([+-]?\d+)\s*日目/;

/**
 * 文字列から相対時期を読む。読めなければ `null`。
 *
 * 読める形は `day+14 夕`・`day+14`・`14日目 夕`・`day-3 朝`・`3日目の夜` など。
 * **日数が読めない文字列は、区分だけが書いてあっても `null` にする**
 * （「夕方」だけでは、どの日の夕方か決められない）。
 */
export function parseRelativeTime(text: string): RelativeTime | null {
  if (typeof text !== "string") return null;
  const normalized = normalizeDigits(text).trim();
  if (normalized.length === 0) return null;

  const matched = DAY_LABEL.exec(normalized) ?? DAY_JAPANESE.exec(normalized);
  if (!matched) return null;
  const day = Number(matched[1]);
  if (!Number.isSafeInteger(day)) return null;

  const rest = normalized.slice(matched[0].length).replace(/^[\s　のご、,]+/, "");
  return { day, part: readPart(rest) };
}

/**
 * 2つの時期の前後。
 *
 * **同じ日で、どちらかの区分が `null` なら 0 を返す。** これは「同時」では
 * なく「順序不明」である——`null` は朝より前でも夜より後でもない。
 * 呼ぶ側は `isOrderUnknown` で見分け、候補の確信度を1段下げる。
 */
export function compareRelativeTime(a: RelativeTime, b: RelativeTime): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.part === null || b.part === null) return 0;
  const diff = PART_ORDER[a.part] - PART_ORDER[b.part];
  return diff === 0 ? 0 : diff < 0 ? -1 : 1;
}

/** 同じ日で、どちらかの区分が分からないため前後が読めないか */
export function isOrderUnknown(a: RelativeTime, b: RelativeTime): boolean {
  return a.day === b.day && (a.part === null || b.part === null);
}

/**
 * 作者に見せる形にする（`14日目 夕`）。
 *
 * 起点より前（負の日）は「◯日目」と書くと読めないので、
 * 「起点の3日前」と書く。
 */
export function formatRelativeTime(time: RelativeTime): string {
  const day =
    time.day > 0
      ? `${time.day}日目`
      : time.day === 0
        ? "起点の日"
        : `起点の${-time.day}日前`;
  return time.part === null ? day : `${day} ${time.part}`;
}

/**
 * 並べ替えのための目盛り。
 *
 * 区分が `null` のときは 0（その日の先頭）に置く。`compareRelativeTime` が
 * 「順序不明」で 0 を返すのとは別の話で、**並べるには全順序が要る**。
 * 前後の判断はあくまで `compareRelativeTime` が行う。
 */
export function relativeTimeKey(time: RelativeTime): number {
  return time.day * 8 + (time.part === null ? 0 : PART_ORDER[time.part]);
}

/** 全角の数字と符号を半角へ。長音記号（ー）は符号と紛らわしいので触らない */
function normalizeDigits(text: string): string {
  return text
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0)
    )
    .replace(/＋/g, "+")
    .replace(/－/g, "-");
}

function readPart(rest: string): TimePart | null {
  for (const [alias, part] of PART_ALIASES) {
    if (rest.startsWith(alias)) return part;
  }
  return null;
}
