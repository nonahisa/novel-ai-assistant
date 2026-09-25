import type { EpisodeKind } from "../models/types";
import { toHalfWidthDigits } from "./episodeParser";

/**
 * AIの答えに書かれた「第N話」が、作品に実在するかを確かめる
 * （2026-09-25 精査 F5。実装ルール3「AIの出力を信用しない」）。
 *
 * 作者の実機（2026-09-15）：2話ぶんしかない確認用の作品で「AIで再読込」を
 * 押すと、gemma4:12b が「第17話を根拠に文佳の祖母」と返した。提案は作者が
 * 選べば設定資料にそのまま載るので、**無い話を根拠にした値**はコードで落とす。
 *
 * **ここで確かめられるのは「その話が作品にあるか」まで。** 第17話が実在して
 * いて、そこに書いていないことを書いた場合は捕まえられない（本文との照合が
 * 要る。`evidence` の逐語照合がその役を担う経路もある）。
 *
 * VS Code API に依存しない。
 */

/** 漢数字の1桁 */
const KANJI_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * 「十七」「二十」「百二」のような漢数字を数へ。読めなければ undefined。
 *
 * 話数に千を超えるものはまず無いので、百の位までを読む。
 */
function kanjiToNumber(text: string): number | undefined {
  if (!text) return undefined;
  // 「一七」のような位取りの無い書き方
  if (!/[十百]/u.test(text)) {
    let value = 0;
    for (const char of text) {
      const digit = KANJI_DIGITS[char];
      if (digit === undefined) return undefined;
      value = value * 10 + digit;
    }
    return value;
  }
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char === "百" || char === "十") {
      const unit = char === "百" ? 100 : 10;
      total += (current === 0 ? 1 : current) * unit;
      current = 0;
      continue;
    }
    const digit = KANJI_DIGITS[char];
    if (digit === undefined) return undefined;
    current = digit;
  }
  return total + current;
}

function toChapterNumber(raw: string): number | undefined {
  const digits = toHalfWidthDigits(raw);
  if (/^[0-9]+$/u.test(digits)) return Number(digits);
  return kanjiToNumber(raw);
}

/** 話数に使う文字（算用数字・全角・漢数字） */
const NUMBER = "[0-9０-９〇零一二三四五六七八九十百]+";
/** 範囲・列挙の区切り（「1〜3」「2・5」「2、第5」） */
const SEPARATOR = "\\s*[〜～~\\-－ー―・、,，]\\s*第?\\s*";

/**
 * 「第N話」と、範囲・列挙を1つの塊として拾う。
 *
 * **「第」の無い形（「3話から」）は算用数字のときだけ拾う。** 漢数字で
 * 「第」が無いと「一話完結」のような話数でない言い回しと区別できない。
 */
const WITH_DAI = new RegExp(
  `第\\s*(${NUMBER}(?:${SEPARATOR}${NUMBER})*)\\s*話`,
  "gu"
);
const WITHOUT_DAI = /(?<![第0-9０-９])([0-9０-９]+(?:\s*[〜～~\-－・、,，]\s*[0-9０-９]+)*)\s*話/gu;

/**
 * 値の中で名指しされた話数。書かれた順に、重ねずに返す。
 *
 * 範囲「第1〜3話」は**書かれた端の数**（1と3）を返す。間の話を全部並べると、
 * 作品が飛び番のときに書いていない話まで確かめることになる。
 */
export function citedChapters(text: string): number[] {
  const found: number[] = [];
  const push = (raw: string): void => {
    const value = toChapterNumber(raw);
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return;
    if (!found.includes(value)) found.push(value);
  };
  const splitter = new RegExp(SEPARATOR, "u");
  for (const match of text.matchAll(WITH_DAI)) {
    for (const part of match[1].split(splitter)) push(part.trim());
  }
  for (const match of text.matchAll(WITHOUT_DAI)) {
    for (const part of match[1].split(/\s*[〜～~\-－・、,，]\s*/u)) push(part.trim());
  }
  return found;
}

/**
 * 値が挙げた話数のうち、作品に無いもの。
 *
 * **話数の分かる話が1つも無い作品では確かめない**（空を返す）。題だけの
 * ファイル名や日付名の作品で、全部の提案を落とすことになるため。
 */
export function unknownCitedChapters(
  text: string,
  known: ReadonlySet<number>
): number[] {
  if (known.size === 0) return [];
  return citedChapters(text).filter((chapter) => !known.has(chapter));
}

/**
 * 作品の話数を集める。
 *
 * **合本（「003-005_合本.txt」）は範囲の中の話を全部数える。** 最後の話数
 * だけにすると、第4話を挙げた正しい提案まで落とす。プロローグ・幕間などの
 * 番号の無い話は数えない（「第N話」とは呼ばれない）。
 */
export function knownChaptersOf(
  episodes: ReadonlyArray<{
    kind: EpisodeKind;
    chapterStart: number | null;
    chapterEnd: number | null;
  }>
): Set<number> {
  const known = new Set<number>();
  for (const episode of episodes) {
    if (episode.kind !== "本編" && episode.kind !== "不明") continue;
    const start = episode.chapterStart ?? episode.chapterEnd;
    const end = episode.chapterEnd ?? episode.chapterStart;
    if (start === null || end === null) continue;
    // 範囲が壊れていても（逆順・巨大）固まらないよう、上限を切る
    const low = Math.min(start, end);
    const high = Math.min(Math.max(start, end), low + 10000);
    for (let chapter = low; chapter <= high; chapter++) known.add(chapter);
  }
  return known;
}
