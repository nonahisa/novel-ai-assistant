import * as path from "path";
import type { EpisodeKind } from "../models/types";

export interface ParsedFileName {
  chapterStart: number | null;
  chapterEnd: number | null;
  subtitle: string | null;
  kind: EpisodeKind;
  /** ファイル名が数字のみ（初期状態）か */
  isInitialName: boolean;
  /**
   * 日付で名付けられたファイルの日付（`YYYY-MM-DD`）。
   *
   * SNS記事は投稿日で管理する（設計書6.4.6）。**話数ではない**ので
   * `chapterStart` には入れない。番号は走査のときに日付順で振る
   * （`scanner.ts`）。日付をそのまま話数にすると `第20260816話` になる。
   */
  date: string | null;
  /**
   * 同じ日の何件目か（`2026-08-16_2` の 2）。
   *
   * **1日に何本も書ける。** 日付だけでは2本目のファイル名が作れないので、
   * 日付の後ろの数字を順序として持つ。時刻を入れた `2026-08-16_1230` も
   * 同じ扱いで、どちらも「その日の中での並び」として働く。
   */
  dateSeq: number | null;
}

/**
 * 日付で名付けられたファイルを読む（設計書6.4.6）。
 *
 * SNS記事は投稿日で管理する。想定する形：
 *   2026-08-16            -> 2026年8月16日
 *   2026_08_16 / 2026.08.16 / 20260816
 *   2026-08-16_海辺の話    -> 日付＋題
 *   2026-08-16_2          -> 同じ日の2件目
 *   2026-08-16_1230       -> 同じ日の、時刻で並べたもの
 *   2026-08-16_2_海辺の話  -> 2件目＋題
 *
 * **1日に何本でも書ける。** 日付だけでは2本目のファイル名が作れないので、
 * 日付の後ろの数字を「その日の中での並び」として読む。
 *
 * **実在しない日付は日付として扱わない。** 「2026-13-01」を日付にすると、
 * 単なる数字の羅列まで投稿日にしてしまう。読めなければ従来の解釈へ回す。
 *
 * `20260816` のような区切り無しは**8桁のときだけ**見る。桁数を緩めると、
 * 話数の初期名（`00120250` のような長い番号）まで日付にしかねない。
 */
function parseDateName(base: string): ParsedFileName | null {
  const matched =
    /^(\d{4})[-_./](\d{1,2})[-_./](\d{1,2})(?:[\s_.．・-]+(.*))?$/.exec(base) ??
    /^(\d{4})(\d{2})(\d{2})(?:[\s_.．・-]+(.*))?$/.exec(base);
  if (!matched) return null;

  const [, year, month, day, rest] = matched;
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  if (!isRealDate(date)) return null;

  // 日付の後ろが数字で始まっていれば、その日の中での並び。
  // 「2026-08-16_2_海辺の話」のように、題が続くこともある
  const tail = rest?.trim() ?? "";
  const withSeq = /^(\d+)(?:[\s_.．・-]+(.*))?$/.exec(tail);
  const dateSeq = withSeq ? parseInt(withSeq[1], 10) : null;
  const title = (withSeq ? withSeq[2] : tail)?.trim() || null;

  return {
    chapterStart: null,
    chapterEnd: null,
    // 並びの数字を題として出すと、一覧に「2」とだけ並ぶ
    subtitle: title,
    kind: "本編",
    // 題が無ければ、話数の初期名と同じく「まだ題を付けていない」状態
    isInitialName: title === null,
    date,
    dateSeq,
  };
}

/** 実在する日付か。2月30日のような組み合わせを弾く */
function isRealDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

/** 全角数字を半角に変換 */
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
}

/**
 * ファイル名から話数・サブタイトル・種別を解析する。
 *
 * 想定するパターン（カクヨム・小説家になろうからのDLを含む）:
 *   001.txt                 -> 1話、初期名
 *   007_湖畔の誓い.txt       -> 7話、サブタイトルあり
 *   003-005_合本.txt         -> 3〜5話
 *   第12話 再会.md           -> 12話
 *   12話.txt                 -> 12話
 *   プロローグ.txt            -> プロローグ
 *   幕間1.txt                -> 幕間
 */
export function parseEpisodeFileName(fileName: string): ParsedFileName {
  const base = toHalfWidthDigits(path.basename(fileName, path.extname(fileName)).trim());

  // **日付をいちばん先に見る。**
  // 「2026-08-16」は話数の範囲（2026〜08）としても、数字＋サブタイトル
  // （第2026話「08-16」）としても読めてしまう。実際に後者として読まれており、
  // 一覧にも並び順にも出鱈目な話数が出ていた
  const dated = parseDateName(base);
  if (dated) return dated;

  // 種別の判定を先に行う
  const kind = detectKind(base);
  if (kind !== "本編") {
    // プロローグ等でも末尾に数字があれば拾う（幕間1 など）
    const numInKind = base.match(/(\d+)\s*$/);
    return {
      chapterStart: numInKind ? parseInt(numInKind[1], 10) : null,
      chapterEnd: numInKind ? parseInt(numInKind[1], 10) : null,
      subtitle: null,
      kind,
      isInitialName: false,
      date: null,
      dateSeq: null,
    };
  }

  // パターン1: 数字のみ（初期状態）  例: "001", "7"
  const onlyNumber = base.match(/^(\d+)$/);
  if (onlyNumber) {
    const n = parseInt(onlyNumber[1], 10);
    return {
      chapterStart: n,
      chapterEnd: n,
      subtitle: null,
      kind: "本編",
      isInitialName: true,
      date: null,
      dateSeq: null,
    };
  }

  // パターン2: 話数範囲  例: "003-005", "3〜5", "003-005_合本"
  const range = base.match(/^(\d+)\s*[-–—~〜]\s*(\d+)(?:[\s_.．・-]+(.*))?$/);
  // 後ろが小さい組み合わせは話数範囲ではない。
  // 日付を名前にした下書き（「2026-08-12.txt」）が
  // 「第2026〜8話」という**ありえない範囲**として読まれていた。
  // 表示も並び順も壊れ、範囲が逆なので登場話数は空になり、
  // そのファイルから抽出した人物に話数が1つも付かなくなる。
  // 範囲として読まず、次の形式（数字＋サブタイトル）へ回す
  if (range && parseInt(range[2], 10) >= parseInt(range[1], 10)) {
    const start = parseInt(range[1], 10);
    const end = parseInt(range[2], 10);
    return {
      chapterStart: start,
      chapterEnd: end,
      subtitle: range[3]?.trim() || null,
      kind: "本編",
      isInitialName: !range[3],
      date: null,
      dateSeq: null,
    };
  }

  // パターン3: 「第N話」形式  例: "第12話 再会", "第12話_再会"
  const withPrefix = base.match(/^第?\s*(\d+)\s*話(?:[\s_.．・-]+(.*))?$/);
  if (withPrefix) {
    const n = parseInt(withPrefix[1], 10);
    return {
      chapterStart: n,
      chapterEnd: n,
      subtitle: withPrefix[2]?.trim() || null,
      kind: "本編",
      isInitialName: !withPrefix[2],
      date: null,
      dateSeq: null,
    };
  }

  // パターン4: 数字＋区切り＋サブタイトル  例: "007_湖畔の誓い", "007 湖畔の誓い"
  const numberWithSubtitle = base.match(/^(\d+)[\s_.．・-]+(.+)$/);
  if (numberWithSubtitle) {
    const n = parseInt(numberWithSubtitle[1], 10);
    return {
      chapterStart: n,
      chapterEnd: n,
      subtitle: numberWithSubtitle[2].trim(),
      kind: "本編",
      isInitialName: false,
      date: null,
      dateSeq: null,
    };
  }

  // パターン5: 英字プレフィックス＋数字範囲
  //   例: "episode_0003-0005", "ep03-05"
  const prefixRange = base.match(
    /^[A-Za-z]+[\s_.．・-]*(\d+)\s*[-–—~〜]\s*(\d+)(?:[\s_.．・-]+(.*))?$/
  );
  // ここも同じ理由で、後ろが小さい組み合わせは範囲として扱わない
  if (prefixRange && parseInt(prefixRange[2], 10) >= parseInt(prefixRange[1], 10)) {
    return {
      chapterStart: parseInt(prefixRange[1], 10),
      chapterEnd: parseInt(prefixRange[2], 10),
      subtitle: prefixRange[3]?.trim() || null,
      kind: "本編",
      isInitialName: !prefixRange[3],
      date: null,
      dateSeq: null,
    };
  }

  // パターン6: 英字プレフィックス＋数字（＋サブタイトル）
  //   カクヨム・なろうのDLツールが生成する形式
  //   例: "episode_0001", "ep01", "no001_湖畔の誓い", "novel001"
  const prefixNumber = base.match(
    /^[A-Za-z]+[\s_.．・-]*(\d+)(?:[\s_.．・-]+(.*))?$/
  );
  if (prefixNumber) {
    const n = parseInt(prefixNumber[1], 10);
    return {
      chapterStart: n,
      chapterEnd: n,
      subtitle: prefixNumber[2]?.trim() || null,
      kind: "本編",
      isInitialName: !prefixNumber[2],
      date: null,
      dateSeq: null,
    };
  }

  // 判定不能
  return {
    chapterStart: null,
    chapterEnd: null,
    subtitle: null,
    kind: "不明",
    isInitialName: false,
    date: null,
    dateSeq: null,
  };
}

function detectKind(base: string): EpisodeKind {
  if (/^(プロローグ|序章|序|prologue)/i.test(base)) return "プロローグ";
  if (/^(エピローグ|終章|epilogue)/i.test(base)) return "エピローグ";
  if (/^(幕間|閑話|間章|interlude)/i.test(base)) return "幕間";
  return "本編";
}

/**
 * 既存ファイル群から、次に作成すべき話数を求める。
 * 本編の最大話数 + 1 を返す。1件もなければ 1。
 */
export function nextChapterNumber(existing: ParsedFileName[]): number {
  let max = 0;
  for (const e of existing) {
    if (e.kind !== "本編") continue;
    const end = e.chapterEnd ?? e.chapterStart;
    if (end !== null && end > max) max = end;
  }
  return max + 1;
}

/**
 * 日付で名付けるときの、次のファイル名の基底部分（設計書6.4.6）。
 *
 * **同じ日に何本でも書ける。** その日のファイルが既にあれば、
 * `2026-08-16_2`, `_3` と番号を足す。
 *
 * 1本目に `_1` は付けない。1本しか無い日に番号があると、
 * 「他にもあるのか」と探させることになる。
 */
export function nextDatedName(
  existing: ParsedFileName[],
  todayKey: string
): string {
  const sameDay = existing.filter((entry) => entry.date === todayKey);
  if (sameDay.length === 0) return todayKey;

  // 番号の無いもの（その日の1本目）も1つとして数える
  let max = 1;
  for (const entry of sameDay) {
    const seq = entry.dateSeq ?? 1;
    if (seq > max) max = seq;
  }
  return `${todayKey}_${max + 1}`;
}

/** 話数をゼロ埋めしたファイル名の基底部分にする */
export function formatChapterNumber(n: number, digits: number): string {
  return String(n).padStart(digits, "0");
}

/** Windowsのファイル名に使えない文字を全角へ置換する */
export function sanitizeFileName(name: string): string {
  const map: Record<string, string> = {
    "/": "／",
    "\\": "＼",
    ":": "：",
    "*": "＊",
    "?": "？",
    '"': "”",
    "<": "＜",
    ">": "＞",
    "|": "｜",
  };
  return name
    .replace(/[/\\:*?"<>|]/g, (c) => map[c] ?? "_")
    // 制御文字を除去
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    // 末尾のピリオド・空白はWindowsで問題になる
    .replace(/[.\s]+$/, "");
}
