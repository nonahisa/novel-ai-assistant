/**
 * 「その熟語は、音読みをつないだだけか」を見る（作者の報告、2026-09-12）。
 *
 * 推敲の「漢字ひらき」が、実データでこう出した。
 *
 *   基礎学力六十点、人物適性百点、遺伝適性百点、実技加点八十点。
 *   → きそがくりょく六十点、じんぶつてきせい百点、…
 *
 * 作者の言葉は「『基礎学力』などをひらく意味がわかりません」である。
 * **音読みで普通に読める熟語をかなにしても、読みやすくならない。**
 * むしろ読めなくなる。
 *
 * ところが、**本当にひらくべきものは音読みと一致しない。**
 * 常用漢字表（平成22年内閣告示第2号）の音訓で引くと、はっきり分かれる。
 *
 * | 語 | 音をつなぐと | ひらき | 一致 |
 * |---|---|---|---|
 * | 基礎学力 | き＋そ＋がく＋りょく | きそがくりょく | **する** |
 * | 出来る | しゅつ／すい＋らい | できる | しない |
 * | 何時 | か＋じ | いつ | しない |
 * | 所謂・殆ど | （表外字を含む） | いわゆる・ほとんど | 読みを組めない |
 *
 * だから「音読みをつないだだけ」を関門にできる。判定はここに置き、
 * VS Code APIにも本文の読み書きにも依存しない純粋関数にしてある。
 */

import { diffChars } from "./inlineDiff";
import { readingsOf } from "./jouyouOnKun";

/**
 * 熟語として見る長さの上限。
 *
 * 4字（「基礎学力」）で足り、長くすると総当たりの組が増えるだけである。
 * それ以上つながった並びは、熟語というより文なので見ない。
 */
const MAX_COMPOUND_CHARS = 6;

/**
 * `kanji` の読みが、常用漢字表に載っている**音読みをつないだだけ**か。
 *
 * 許すのは連濁と促音便の2つだけである（下の `variantsOf`）。
 * **それ以上は広げない**——広げるほど、本当にひらくべき語を巻き込む。
 *
 * 次のときは `false`（＝判定しない）。
 *
 * - 漢字が1字（「然し」のような形は、この関門の対象ではない）
 * - 表に無い字が1つでも混じる（読みを組めない）
 * - 訓が混じる（「株式会社＝かぶ＋しき＋がい＋しゃ」の「かぶ」は訓）
 *
 * @param kanji 漢字の並び（2字以上）
 * @param kana ひらがなの読み
 */
export function isOnyomiReading(kanji: string, kana: string): boolean {
  const chars = Array.from(kanji);
  if (chars.length < 2 || kana.length === 0) return false;

  // 各字の候補読み（平仮名）。1字でも組めなければ、その時点で判定しない
  const readings: string[][] = [];
  for (const char of chars) {
    const entry = readingsOf(char);
    if (!entry || entry.on.length === 0) return false;
    readings.push(entry.on.map(toHiragana));
  }

  // 「ここまで来たが合わなかった」を覚える。候補の組み合わせは
  // 字数に対して掛け算で増えるので、同じ行き止まりを何度も踏まない
  const deadEnds = new Set<string>();

  const match = (index: number, at: number): boolean => {
    if (index === readings.length) return at === kana.length;
    const state = `${index}|${at}`;
    if (deadEnds.has(state)) return false;
    for (const reading of readings[index]) {
      for (const variant of variantsOf(
        reading,
        index > 0,
        index < readings.length - 1
      )) {
        if (!kana.startsWith(variant, at)) continue;
        if (match(index + 1, at + variant.length)) return true;
      }
    }
    deadEnds.add(state);
    return false;
  };

  return match(0, 0);
}

/**
 * 1字ぶんの読みの、許される形。
 *
 * **連濁と促音便の2つだけ**を許す（作者の指定、2026-09-12）。
 *
 * - 連濁：後ろの語の頭が濁る（「学校」の「校」ではなく、「絵日記」の「日」）。
 *   先頭の字には起きないので `canRendaku` で切る
 * - 促音便：前の語の末尾が「っ」になる（学校＝ガク＋コウ→がっこう）。
 *   最後の字には起きないので `canSokuon` で切る
 *
 * 2つは働く場所が違う（頭と末尾）ので、同じ字に両方が重なることもある
 * （「各国＝カク＋コク→かっこく」の「国」は濁らないが、濁る語もある）。
 */
function variantsOf(
  reading: string,
  canRendaku: boolean,
  canSokuon: boolean
): string[] {
  const bases = canRendaku ? [reading, ...rendakuOf(reading)] : [reading];
  const variants: string[] = [];
  for (const base of bases) {
    variants.push(base);
    if (!canSokuon) continue;
    const sokuon = sokuonOf(base);
    if (sokuon) variants.push(sokuon);
  }
  return variants;
}

/** 連濁の対応。は行だけは濁音と半濁音の2通りがある（「一本＝いっぽん」） */
const RENDAKU: Record<string, string[]> = {
  か: ["が"], き: ["ぎ"], く: ["ぐ"], け: ["げ"], こ: ["ご"],
  さ: ["ざ"], し: ["じ"], す: ["ず"], せ: ["ぜ"], そ: ["ぞ"],
  た: ["だ"], ち: ["ぢ"], つ: ["づ"], て: ["で"], と: ["ど"],
  は: ["ば", "ぱ"], ひ: ["び", "ぴ"], ふ: ["ぶ", "ぷ"],
  へ: ["べ", "ぺ"], ほ: ["ぼ", "ぽ"],
};

function rendakuOf(reading: string): string[] {
  const voiced = RENDAKU[reading[0]];
  if (!voiced) return [];
  return voiced.map((head) => head + reading.slice(1));
}

/**
 * 促音便。**末尾が「く・き・つ・ち」のときだけ**「っ」になる
 * （学校＝ガク→がっ、実施＝ジツ→じっ）。
 */
function sokuonOf(reading: string): string | undefined {
  const last = reading[reading.length - 1];
  if (!"くきつち".includes(last)) return undefined;
  return `${reading.slice(0, -1)}っ`;
}

/** 片仮名を平仮名へ。表の音は片仮名で持っているので、比べる前に揃える */
function toHiragana(katakana: string): string {
  return katakana.replace(/[ァ-ヶ]/g, (char) =>
    String.fromCodePoint(char.codePointAt(0)! - 0x60)
  );
}

/** 漢字（`readingsOf` が引ける字かどうかは、引いてから決める） */
const KANJI_RUN = /\p{Script=Han}+/gu;
/** ひらがなの並び（長音符は読みに現れないので入れない） */
const KANA_RUN = /[ぁ-ゖ]+/gu;

/**
 * 修正案が、**音読みをつないだだけの熟語をひらこうとしていないか**。
 *
 * 原文と修正案を突き合わせ、漢字の並びがかなへ置き換わっている箇所を
 * 取り出して、1つでも「音読みをつないだだけ」なら `true` を返す
 * （1文に4語あっても、1つ当たれば指摘ごと落とす。作者の例は4つとも当たる）。
 *
 * **差分は `inlineDiff` の `diffChars` を使う**（写しを作らない）。
 * ただし置き換えが多いと `diffChars` は「まるごと消してまるごと足す」へ
 * 落ちるので、取り出した組の中をもう一段見る——消えた側の**漢字の並び**と、
 * 足された側の**かなの並び**を突き合わせる。漢字の並びには「六十点」のような
 * 数字がくっついてくるので、**前後の切り出し**（先頭からと末尾から）も試す。
 */
export function opensOnyomiCompound(
  original: string,
  suggestion: string
): boolean {
  if (!original || !suggestion) return false;

  for (const [removed, added] of replacedPairs(original, suggestion)) {
    const kanjiRuns = removed.match(KANJI_RUN) ?? [];
    const kanaRuns = added.match(KANA_RUN) ?? [];
    for (const kanjiRun of kanjiRuns) {
      for (const kanaRun of kanaRuns) {
        if (matchesAnyEdge(kanjiRun, kanaRun)) return true;
      }
    }
  }
  return false;
}

/**
 * 漢字の並びの**先頭から**、または**末尾から**切り出した2〜6字が、
 * そのかなと一致するか。
 *
 * まるごと一致（「基礎学力」＝「きそがくりょく」）はどちらの向きにも
 * 含まれる。途中だけを切り出さないのは、差分が並びの端を揃えて返すため、
 * 変わったのは必ず端からになるからである。
 */
function matchesAnyEdge(kanjiRun: string, kanaRun: string): boolean {
  const chars = Array.from(kanjiRun);
  const limit = Math.min(chars.length, MAX_COMPOUND_CHARS);
  for (let length = 2; length <= limit; length++) {
    if (isOnyomiReading(chars.slice(0, length).join(""), kanaRun)) return true;
    if (isOnyomiReading(chars.slice(-length).join(""), kanaRun)) return true;
  }
  return false;
}

/** 差分のうち、「消えて・足された」（＝置き換わった）組だけを拾う */
function replacedPairs(
  original: string,
  suggestion: string
): Array<[string, string]> {
  const segments = diffChars(original, suggestion);
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index + 1 < segments.length; index++) {
    const left = segments[index];
    const right = segments[index + 1];
    if (left.kind === "removed" && right.kind === "added") {
      pairs.push([left.text, right.text]);
    } else if (left.kind === "added" && right.kind === "removed") {
      // 並ぶ順は `diffChars` の都合で入れ替わることがある
      pairs.push([right.text, left.text]);
    }
  }
  return pairs;
}
