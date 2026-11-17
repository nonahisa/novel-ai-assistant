import { INTERNAL_RUBY_SOURCE, findRuby, fromSiteNotation } from "./ruby";
import { deriveReading, toDictionaryReading } from "./reading";

/**
 * 本文でよく使う語を数える（設計書6.13.7）。オリジナルIME へ渡す辞書の末尾の行になる。
 *
 * 拾うのは2種類だけ：
 * - 本文でルビが付いた語（読みはルビ）
 * - 3字以上のカタカナの連なり（読みは字面から作る）
 *
 * **漢字だけでルビの無い語は出さない**（読みが決められず、当て推量の行は変換を荒らす）。
 *
 * 入力は話の本文の文字列、出力は語・読み・回数だけ。**本文は出力に残らない**
 * （辞書は作品のフォルダーの外へも渡るので、本文の断片を載せない）。
 *
 * 純粋な部分だけ。`vscode`・`node:`・`path` を引き込まない（ブラウザ版でも動く形。設計書5.8）。
 */

/** 作品全体でこの回数以上出た語だけ出す */
export const IME_FREQUENT_MIN_COUNT = 3;
/** 語の最小の長さ（字） */
const MIN_SURFACE_CHARS = 2;
/** カタカナの連なりの最小の長さ（字） */
const MIN_KATAKANA_RUN = 3;

export interface FrequentWord {
  surface: string;
  /** ひらがなの読み */
  reading: string;
  /** 作品全体での回数 */
  count: number;
}

/** 回数の多い順、同じなら表記・読みの順（コード順。環境によらず同じ並びになる） */
export function compareFrequent(a: FrequentWord, b: FrequentWord): number {
  if (a.count !== b.count) return b.count - a.count;
  if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1;
  if (a.reading !== b.reading) return a.reading < b.reading ? -1 : 1;
  return 0;
}

const HIRAGANA_ONLY = /^[\p{Script=Hiragana}ー]+$/u;
const KATAKANA_RUN = /[\p{Script=Katakana}ー]+/gu;

function charLength(text: string): number {
  return [...text].length;
}

/**
 * 本文の束から数える。
 *
 * @param bodies 話の本文（サイト記法のままでよい）
 * @param excludedSurfaces 出さない表記（設定資料の語・作者が外した語）
 */
export function countFrequentWords(
  bodies: readonly string[],
  excludedSurfaces: ReadonlySet<string>,
  minCount: number = IME_FREQUENT_MIN_COUNT
): FrequentWord[] {
  // 表記ごとに、読みごとの回数。区切りの文字を鍵に混ぜず、入れ子の Map で持つ
  const counts = new Map<string, Map<string, number>>();
  const add = (surface: string, reading: string): void => {
    let byReading = counts.get(surface);
    if (!byReading) {
      byReading = new Map();
      counts.set(surface, byReading);
    }
    byReading.set(reading, (byReading.get(reading) ?? 0) + 1);
  };

  for (const raw of bodies) {
    // サイト記法を内部記法へ直してから拾う（3種類の記法を1つの口で扱う）
    const text = fromSiteNotation(raw);

    for (const { base, reading } of findRuby(text)) {
      const surface = base.trim();
      if (charLength(surface) < MIN_SURFACE_CHARS) continue;
      if (HIRAGANA_ONLY.test(surface)) continue;
      const yomi = toDictionaryReading(reading);
      if (!yomi || yomi === surface) continue;
      add(surface, yomi);
    }

    // ルビの付いた語は上で数えた。カタカナの数え直しで二重にならないよう外す
    const rest = text.replace(new RegExp(INTERNAL_RUBY_SOURCE, "gu"), "\n");
    for (const match of rest.matchAll(KATAKANA_RUN)) {
      const surface = match[0];
      if (charLength(surface) < MIN_KATAKANA_RUN) continue;
      // 長音で始まる連なりは語の途中から切れたもの
      if (surface.startsWith("ー")) continue;
      const yomi = deriveReading(surface);
      const resolved = yomi ? toDictionaryReading(yomi) : undefined;
      if (!resolved || resolved === surface) continue;
      add(surface, resolved);
    }
  }

  const result: FrequentWord[] = [];
  for (const [surface, byReading] of counts) {
    if (excludedSurfaces.has(surface)) continue;
    for (const [reading, count] of byReading) {
      if (count >= minCount) result.push({ surface, reading, count });
    }
  }
  return result.sort(compareFrequent);
}
