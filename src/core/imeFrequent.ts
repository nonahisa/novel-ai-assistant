import { INTERNAL_RUBY_SOURCE, findRuby, fromSiteNotation } from "./ruby";
import { deriveReading, toDictionaryReading } from "./reading";
import * as path from "./pathText";
import { acceptManuscriptEntry, isKnownNonManuscript } from "./manuscriptFolderRule";

/**
 * 本文でよく使う語を数える（設計書6.13.7）。Rittoku IME へ渡す辞書の末尾の行になる。
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

/**
 * 話のファイルか（話の保存で「よく使う語」を数え直すかの判定）。
 *
 * 走査（`scanWork`）が話として拾う条件と揃える：`.txt`/`.md`、`.` で始まる名前の
 * フォルダー（`.aiwriter`・`.novelai-recovery`・ゴミ箱）の下ではない、`exports`・`設定`・
 * 設定フォルダーの下ではない、競合の退避ファイルではない、作品の根の README などではない。
 * **選り分けは `acceptManuscriptEntry` に任せる**（写しを作ると片方だけ古くなる）。
 *
 * 本文フォルダーの中かまでは見ない（読み口が要るため）。数え直すのが無駄になるだけで、
 * 数える側は走査の結果だけを読むので、話でないファイルが混ざることはない。
 */
export function isEpisodeFilePath(
  workFolder: string,
  settingsDir: string,
  filePath: string
): boolean {
  if (!path.isPathInside(workFolder, filePath)) return false;
  const relative = path.relative(workFolder, filePath);
  const segments = relative.split(/[\\/]+/).filter((part) => part !== "");
  if (segments.length === 0) return false;
  const accept = acceptManuscriptEntry(settingsDir);
  let current = workFolder;
  for (const [index, name] of segments.entries()) {
    current = path.join(current, name);
    if (index < segments.length - 1) {
      if (name.startsWith(".") || !accept(name, "directory", current)) return false;
    } else if (!accept(name, "file", current)) {
      return false;
    }
  }
  return !isKnownNonManuscript(filePath, workFolder, settingsDir);
}

/**
 * 「よく使う語を選ぶ」窓のあとに覚える外した語を決める。
 *
 * 覚えるのは外した語。**前に外していて、いまの一覧に出ない語（本文から減った・設定資料に入った）の
 * 覚えは消さない。** 前の覚えと今回外した語の和から、今回チェックした語を引く。
 *
 * @param previous 前に覚えた外した語
 * @param shown 今回の一覧に出した語の表記
 * @param checked 今回チェックが入っていた語の表記
 */
export function nextFrequentExcluded(
  previous: readonly string[],
  shown: readonly string[],
  checked: readonly string[]
): string[] {
  const keep = new Set(checked);
  const result = new Set(previous);
  for (const surface of shown) {
    if (!keep.has(surface)) result.add(surface);
  }
  for (const surface of keep) result.delete(surface);
  return [...result];
}

/**
 * 辞書の組み直しで、よく使う語から除く表記。
 * 設定資料の語（外した語も含む）・設定資料の語として外した語・よく使う語として外した語。
 */
export function frequentSkipSurfaces(
  settingsSurfaces: readonly string[],
  settingsExcluded: readonly string[],
  frequentExcluded: readonly string[]
): Set<string> {
  return new Set([...settingsSurfaces, ...settingsExcluded, ...frequentExcluded]);
}
