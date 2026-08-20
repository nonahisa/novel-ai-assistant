/**
 * 送り仮名ゆれ（設計書6.13.6）。
 *
 * 「行なう／行う」「表わす／表す」「打ち合わせ／打合せ」のように、
 * **同じ語なのに送り仮名の付け方が違う**組を見つける。
 *
 * ## 汎用の検出は諦めた。**語の切り出しができない**
 *
 * 設計書はこれを「活用形を巻き込むから」未実装としていたが、
 * **実データで測ったところ、もっと手前で壊れていた**（2026-08-19）。
 *
 * 漢字から始まる仮名の連なりを語として拾うと、こうなる。
 *
 * ```
 * 今 / 今なら / 今さら / 今や / 今まで / 今の / 今だ / 今から
 * 話 / 話では / 話で / 話に / 話を / 話は / 話す / 話だ
 * ```
 *
 * **これらは語ではない。** 名詞に助詞が付いただけである。作者の10作品から
 * 61,538種類を拾って824組が挙がり、**まともなものは1つも無かった。**
 *
 * 語の切れ目を決めるには**形態素解析**が要る。辞書だけで数百MBあり、
 * この拡張機能が抱えるものではない。
 *
 * ## そこで、**厳選した一覧**で出す
 *
 * かな⇔漢字の表記ゆれ（`KANA_KANJI_PAIRS`）と同じ考えである。
 * **網羅より精度を採る。** 一覧に無いゆれは見つからないが、
 * **無いものを見つけたと言うよりはるかによい。**
 *
 * ## 比較の規則は残す
 *
 * 一覧の正しさを確かめるのと、いつか形態素解析を持てたときのために、
 * 「送り仮名ゆれか」を判定する部分は残してある。
 *
 * 漢字を抜き出して比べるだけでは、次の2つが同じ形に見える。
 *
 * ```
 * 行なう / 行う   ← 送り仮名ゆれ（直すべき）
 * 行った / 行く   ← 活用形（直してはいけない）
 * ```
 *
 * どちらも「漢字は 行 で同じ、あとの仮名が違う」である。
 *
 * ## 見分け方：短いほうが、長いほうの**末尾**になっているか
 *
 * ```
 * 行なう → なう      行う → う      「う」は「なう」の末尾  → 送り仮名ゆれ
 * 行った → った      行く → く      「く」は「った」の末尾でない → 活用形
 * ```
 *
 * **送り仮名は語尾から付く。** 付け方が違っても語尾は変わらないので、
 * 短いほうは長いほうの末尾に必ず含まれる。活用すると語尾そのものが
 * 変わるので、この関係が崩れる。
 *
 * ## それでも外れる場合がある
 *
 * 「上がる（あがる）」と「上る（のぼる）」は**別の語**だが、
 * 「る」は「がる」の末尾なので送り仮名ゆれとして挙がる。
 * 読み仮名の辞書が無い以上、ここは分けられない。
 *
 * そこで**確信度を下げて出す。** 作者が見て違えば「無視」を押せばよく、
 * 「直さない語」に入れれば以後は出ない。
 *
 * VS Code APIに依存しない。
 */

/** 漢字（々・ヶも語の一部として扱う） */
const KANJI = /[一-鿿々々]/u;
/** ひらがな */
const KANA = /[ぁ-ゟ]/u;

/**
 * 1か所あたりで許す送り仮名の差。
 *
 * **実データで決めた**（2026-08-19）。空文字はどんな文字列の末尾でも
 * あるため、上限を置かないと「行」が「行ってみるかな」に一致する。
 * 送り仮名の付け方の違いは多くて2文字である。
 */
const MAX_KANA_DIFFERENCE = 2;

/** 語を「漢字」と「その後ろの仮名」へ分けたもの */
export interface Segment {
  kanji: string;
  kana: string;
}

/**
 * 語を漢字ごとに区切る。
 *
 * 「打ち合わせ」→ `[{打, ち}, {合, わせ}]`
 * 先頭が仮名で始まる語は扱わない（`null`）。**語の切れ目が決められない。**
 */
export function segment(word: string): Segment[] | null {
  const chars = [...word];
  if (chars.length === 0 || !KANJI.test(chars[0])) return null;

  const segments: Segment[] = [];
  for (const char of chars) {
    if (KANJI.test(char)) {
      segments.push({ kanji: char, kana: "" });
    } else if (KANA.test(char)) {
      segments[segments.length - 1].kana += char;
    } else {
      // 記号・英数字が混ざる語は扱わない
      return null;
    }
  }
  return segments;
}

/** 漢字だけを並べたもの。組を見つける手掛かりにする */
export function kanjiSkeleton(word: string): string | null {
  const segments = segment(word);
  return segments ? segments.map((s) => s.kanji).join("") : null;
}

/**
 * 送り仮名ゆれの組か。
 *
 * **漢字が同じで、仮名の付き方だけが違う**こと。そして各位置で、
 * **短いほうが長いほうの末尾になっている**こと。
 */
export function isOkuriganaVariant(a: string, b: string): boolean {
  if (a === b) return false;

  const left = segment(a);
  const right = segment(b);
  if (!left || !right) return false;
  if (left.length !== right.length) return false;

  let differs = false;
  for (let i = 0; i < left.length; i++) {
    if (left[i].kanji !== right[i].kanji) return false;

    const x = left[i].kana;
    const y = right[i].kana;
    if (x === y) continue;
    differs = true;
    // **短いほうが長いほうの末尾になっているか。**
    // ここが活用形との分かれ目である
    const [shorter, longer] = x.length < y.length ? [x, y] : [y, x];
    if (!longer.endsWith(shorter)) return false;

    // **差が大きすぎるものは、送り仮名ゆれではない。**
    //
    // 実データで気づいた（2026-08-19）。空文字はどんな文字列の末尾でも
    // あるため、仮名の付かない「行」が「行ってみるかな」「行きたいの」に
    // すべて一致し、**1つの語に70件が束ねられた。**
    //
    // 送り仮名の付け方の違いは、多くて2文字である（「行なう／行う」は1、
    // 「打ち合わせ／打合せ」は各1）。それを超えるものは別の語である
    if (longer.length - shorter.length > MAX_KANA_DIFFERENCE) return false;
  }
  return differs;
}

/**
 * 語の一覧から、送り仮名ゆれの組を作る。
 *
 * **同じ漢字の骨格を持つものだけを比べる。** 全部を総当たりすると
 * 語数の2乗になり、19話ぶんでも重くなる。
 */
export function groupOkuriganaVariants(
  words: readonly string[]
): string[][] {
  const bySkeleton = new Map<string, string[]>();
  for (const word of new Set(words)) {
    const skeleton = kanjiSkeleton(word);
    if (!skeleton) continue;
    const list = bySkeleton.get(skeleton) ?? [];
    list.push(word);
    bySkeleton.set(skeleton, list);
  }

  const groups: string[][] = [];
  for (const candidates of bySkeleton.values()) {
    if (candidates.length < 2) continue;
    // 骨格が同じでも、活用形どうしは組にしない
    for (const group of buildGroups(candidates)) {
      if (group.length >= 2) groups.push(group);
    }
  }
  return groups;
}

/** 互いに送り仮名ゆれの関係にあるものを束ねる */
function buildGroups(candidates: readonly string[]): string[][] {
  const remaining = [...candidates];
  const groups: string[][] = [];

  while (remaining.length > 0) {
    const head = remaining.shift()!;
    const group = [head];
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (isOkuriganaVariant(head, remaining[i])) {
        group.push(remaining[i]);
        remaining.splice(i, 1);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * 揃える先の既定。
 *
 * **送り仮名の多いほうを既定にする。** 公用文の決まりでは
 * 「行う」のように少ないほうが本則だが、**小説では作者の好みが優先**で、
 * どちらが正しいとも言えない。ここでは**迷ったときに情報が減らないほう**、
 * つまり読み間違えにくい長いほうを既定に置く。作者が選び直せる。
 */
export function defaultTarget(group: readonly string[]): string {
  return [...group].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

/**
 * 送り仮名ゆれとして扱う組。
 *
 * **実際に迷いやすいものだけを入れる。** 公用文の本則（送り仮名を減らす）と
 * 読みやすさ（増やす）がぶつかる語である。
 *
 * **活用しない形だけを入れる。** 「行う／行なう」は入れるが
 * 「行った／行なった」は入れない。活用形まで並べると一覧が膨らみ、
 * **抜けたものが「ゆれていない」ことにされる。**
 *
 * **名詞化した形は分けて持つ。** 「打ち合わせ」は動詞の活用ではなく
 * 独立した名詞で、「打合せ」「打合わせ」まで揺れる。
 *
 * ここに無いゆれは見つからない。**それでよい。**
 */
export const OKURIGANA_GROUPS: readonly (readonly string[])[] = [
  // 動詞（終止形だけ。活用形は入れない）
  ["行う", "行なう"],
  ["表す", "表わす"],
  ["現れる", "現われる"],
  ["終わる", "終る"],
  ["変わる", "変る"],
  ["断る", "断わる"],
  ["著す", "著わす"],

  // 名詞（動詞から出た語。三つに揺れることがある）
  ["打ち合わせ", "打合わせ", "打合せ"],
  ["申し込み", "申込み", "申込"],
  ["問い合わせ", "問合わせ", "問合せ"],
  ["取り扱い", "取扱い", "取扱"],
  ["引っ越し", "引越し", "引越"],
  ["受け付け", "受付け", "受付"],
  ["締め切り", "締切り", "締切"],
  ["書き下ろし", "書下ろし", "書下し"],
].filter((group) => group.length >= 2);
