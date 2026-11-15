import type { Chunk } from "./chunker";
import type { AcceptedTypoIssue } from "./typoCheckValidation";
import { escapeRegExp } from "./regexEscape";

/**
 * 隣どうしの仮名の入れ替わり（「もちろん」→「もろちん」）を、コードで照合する
 * （設計書6.8.21。作者の依頼、2026-11-15「「もろちん」で「もちろん」と誤字検知しない。」）。
 *
 * ## なぜAIに任せず、コードで拾うのか
 *
 * 手元のAI（gemma4:e4b）へ製品と同じ道で撃ったところ、「もろちん」を含む文を
 * 地の文・台詞とも素通りした（2026-11-15 の測り）。入れ替わりは**語の形が
 * 一覧と照らせば機械的に決まる**ので、文章作法（`writingStyleCheck.ts`）と同じく
 * AIの判断を挟まない。AIの実行有無・控え（キャッシュ）に関係なく毎回走るので、
 * 処理済みの作品でも送り直さずに効く。
 *
 * ## 誤検出をどう抑えたか
 *
 * - **4字以上の語だけを載せる。** 3字以下は入れ替わりの形が本物の語の一部に
 *   なりやすい。作者の作品の写し（約92万字）で数えると、「わたし」→「わした」は
 *   「かわした」に18件、「やはり」→「はやり」は「はやりすぎた」に4件当たった
 * - **入れ替わりの形が本物の語（やその一部）になるものは、形ごと除く**
 *   （`REAL_WORD_SWAPS`）。「わからない」→「かわらない」（変わらない）、
 *   「かならず」→「なからず」（少なからず）など
 * - 同じ仮名が並ぶ所（「ぜんぜん」の「ぜぜ」にはならない）は入れ替えても同じなので作らない
 *
 * 載せた語の入れ替わりの形は、作者の作品の写し4作（約92万字）で0件だった
 * （除いた形を除いて。2026-11-15）。
 */

/**
 * よく仮名で書かれる、4字以上の語。
 *
 * **活用する語は、よく出る形をそのまま載せる。** 語幹（「わから」）で照らすと
 * 「やわらか」のような別の語に当たる。
 */
const COMMON_KANA_WORDS: readonly string[] = [
  "もちろん",
  "ありがとう",
  "すみません",
  "いきなり",
  "なるほど",
  "ところで",
  "わからない",
  "やっぱり",
  "おはよう",
  "ちょっと",
  "とりあえず",
  "さっぱり",
  "すっかり",
  "ぜんぜん",
  "いったい",
  "もしかして",
  "もしかしたら",
  "まったく",
  "ふたたび",
  "ほんとう",
  "いろいろ",
  "そろそろ",
  "だんだん",
  "ゆっくり",
  "しっかり",
  "はっきり",
  "どうして",
  "ごめんなさい",
  "よろしく",
  "おねがい",
  "こんにちは",
  "こんばんは",
  "さようなら",
  "いただきます",
  "ごちそうさま",
  "ください",
  "ちゃんと",
  "おかしい",
  "うれしい",
  "あたらしい",
  "むずかしい",
  "たとえば",
  "あらためて",
  "だいじょうぶ",
  "いつのまにか",
  "ようやく",
  "あいかわらず",
  "せっかく",
  "おそらく",
  "もっとも",
  "なにより",
  "そもそも",
  "つまらない",
  "くだらない",
  "すばらしい",
  "めずらしい",
  "おもしろい",
  "いっしょに",
  "ぜったい",
  "けっこう",
  "たしかに",
  "かわいい",
  "やさしい",
  "ほとんど",
  "それでも",
  "しばらく",
  "ひとまず",
  "ほんもの",
  "とにかく",
  "かならず",
  "なかなか",
];

/**
 * 入れ替わりの形のうち、本物の語（やその一部）になるもの。**照らさない。**
 *
 * 一覧の語を入れ替えて出た形を1つずつ目で見て選んだ。足すときも同じく、
 * 全部の形を並べて本物の語に重ならないかを見る（`kanaSwapCheck.test.ts`）。
 */
const REAL_WORD_SWAPS: ReadonlySet<string> = new Set([
  // わからない → 変わらない
  "かわらない",
  // かならず → 少なからず（作者の作品の写しで実際に当たった）
  "なからず",
  // ほんとう → 「ほんとうに」は載せない（「ほんとにう…」＝ほんとに＋うれしい 等に当たる）
  // ほとんど → 「ほんと」＋「どう」
  "ほんとど",
  // たしかに → 「たかし」（名前）＋「に」・「〜したかに見えた」
  "たかしに",
  "したかに",
  // かわいい → 界隈
  "かいわい",
  // やさしい → 「やさい」（野菜）＋「しか」
  "やさいし",
  // あたらしい → 「あたしら」（わたしたち）＋「い…」
  "あたしらい",
  // それでも → 「それも」＋「できる」
  "それもで",
  // しばらく → しらばくれる
  "しらばく",
  // ひとまず → 人妻
  "ひとずま",
  // ほんもの → 「ほんの」＋「もう少し」
  "ほんのも",
  // とにかく → 「〜とか」＋「にく（肉・〜にくい）」・「〜と」＋「にくか（肉か）」
  "とかにく",
  "とにくか",
  // なかなか → 「いなか」（田舎）＋「かな」・「〜かな」＋「なか」
  "なかかな",
  "かななか",
]);

/**
 * 隣どうしの仮名を1か所入れ替えた形 → 正しい語。
 *
 * 一覧の語そのもの（別の語の入れ替わりが、たまたま一覧の語になる場合）と、
 * `REAL_WORD_SWAPS` は入れない。
 */
export const KANA_SWAP_TABLE: ReadonlyMap<string, string> = buildSwapTable(
  COMMON_KANA_WORDS
);

function buildSwapTable(words: readonly string[]): Map<string, string> {
  const known = new Set(words);
  const table = new Map<string, string>();
  for (const word of words) {
    for (const swapped of adjacentSwapsOf(word)) {
      if (known.has(swapped) || REAL_WORD_SWAPS.has(swapped)) continue;
      // 2つの語から同じ形が出たら、どちらへ直すか決められないので載せない
      if (table.has(swapped) && table.get(swapped) !== word) {
        table.delete(swapped);
        continue;
      }
      table.set(swapped, word);
    }
  }
  return table;
}

/** 隣どうしを1か所入れ替えた形を全部（同じ字どうしは入れ替えても同じなので除く） */
export function adjacentSwapsOf(word: string): string[] {
  const chars = [...word];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) {
    if (chars[i] === chars[i + 1]) continue;
    const swapped = chars.slice();
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    out.add(swapped.join(""));
  }
  return [...out];
}

/** 長い形から先に照らす（短い形が長い形の一部を先に取らないように） */
const SWAP_PATTERN = new RegExp(
  [...KANA_SWAP_TABLE.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|"),
  "g"
);

/** original に含める前後の文字数（`writingStyleCheck.ts` と同じ） */
const CONTEXT_RADIUS = 8;

/** 作者が守った語・固有名詞として扱う最短の長さ（`keepWord.ts` の下限と同じ） */
const MIN_GUARD_LENGTH = 2;

export interface KanaSwapGuards {
  /** 固有名詞（人物・能力・場所・組織の name と aliases） */
  protectedNames?: readonly string[];
  /** 作者が「直さない」と決めた語（`設定/keep_words.json`） */
  keepWords?: readonly string[];
}

export function checkKanaSwaps(
  chunk: Chunk,
  guards: KanaSwapGuards = {}
): AcceptedTypoIssue[] {
  const guardWords = [
    ...(guards.protectedNames ?? []),
    ...(guards.keepWords ?? []),
  ]
    .map((word) => word.trim())
    .filter((word) => word.length >= MIN_GUARD_LENGTH);
  const findings: AcceptedTypoIssue[] = [];
  const lines = chunk.text.split("\n");
  lines.forEach((lineText, index) => {
    const lineNumber = chunk.startLine + index + 1;
    const guarded = rangesOf(lineText, guardWords);
    for (const match of lineText.matchAll(SWAP_PATTERN)) {
      const start = match.index ?? 0;
      const target = match[0];
      const end = start + target.length;
      // **作者が守った語・固有名詞に重なる所は直さない。** わざと書いた台詞
      // （言葉遊び）や、たまたま同じ並びを含む名前を、作者が守れるようにする
      if (guarded.some(([from, to]) => start < to && from < end)) continue;
      const correct = KANA_SWAP_TABLE.get(target);
      if (!correct) continue;
      findings.push({
        line: lineNumber,
        original: lineText.slice(
          Math.max(0, start - CONTEXT_RADIUS),
          Math.min(lineText.length, end + CONTEXT_RADIUS)
        ),
        target,
        suggestion: correct,
        reason: `入力ミス：「${correct}」の仮名が入れ替わっているようです。`,
        confidence: "high",
      });
    }
  });
  return findings;
}

function rangesOf(line: string, words: readonly string[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const word of words) {
    let at = line.indexOf(word);
    while (at >= 0) {
      ranges.push([at, at + word.length]);
      at = line.indexOf(word, at + 1);
    }
  }
  return ranges;
}

/**
 * 2つの指摘が、同じ所を同じ形に直すか。
 *
 * コードで拾った入れ替わりを、AIも同じ所で指摘したときに、パネルへ2件並べない
 * ために使う。AIは前後の字を抱えて返すこと（「もろちん、」→「もちろん、」）が
 * あるので、長いほうの対象の中で短いほうの直しを当てて、長いほうの直しと
 * 同じになるかで見る。
 */
export function isSameFix(
  a: Pick<AcceptedTypoIssue, "line" | "target" | "suggestion">,
  b: Pick<AcceptedTypoIssue, "line" | "target" | "suggestion">
): boolean {
  if (a.line !== b.line) return false;
  const [longer, shorter] = a.target.length >= b.target.length ? [a, b] : [b, a];
  if (!longer.target.includes(shorter.target)) return false;
  return (
    longer.target.replace(shorter.target, shorter.suggestion) ===
    longer.suggestion
  );
}
