import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * AIをまとめて呼ぶ前の確認画面に、**作品名を出す**／**「開始」は確認の
 * あとに書く**（ノートPCの実機、2026-09-23）。
 *
 * 詳細メニューの「場所を抽出」が、作品一覧で誤って選ばれていた**作者の
 * 本物の作品**で確認画面（15チャンク・1時間30分）まで進んだ。確認画面に
 * 作品名が無く、件数の違いでやっと気づいた。キャンセルしたのに、その作品の
 * ログには「抽出を開始」が残った（確認より前に書いていたため）。
 *
 * 抽出は `extractCharactersFlow.test.ts` で動かして見ている。ここでは、
 * 同じ形の確認画面を持つほかの機能が、**書き方で**同じ約束を守っているかを
 * 押さえる（それぞれを走らせるには画面の部品を大量に偽る必要がある）。
 */

const FEATURES = join(__dirname, "..", "..", "src", "features");

/**
 * 確認画面（`confirmRun`／`confirmPaidUsage`）を出す、作品に対してAIを
 * 呼ぶ機能。**ここに並べたファイルの確認は、すべて作品名を持つ。**
 */
const CONFIRMING_FILES = [
  "extractCharacters.ts",
  "checkTypos.ts",
  "checkContradictions.ts",
  "checkProofread.ts",
  "checkForeshadows.ts",
  "checkFactContradictions.ts",
  "checkDeviations.ts",
  "checkEpisodePlot.ts",
  "checkOpening.ts",
  "generateSynopses.ts",
  "generatePlot.ts",
  "generateBlurb.ts",
  "generateAnnouncement.ts",
  "proposeChapters.ts",
  "nameCheck.ts",
  "readerTargetDiagnosis.ts",
] as const;

/** 呼び出しの括弧の中身（文字列の中の括弧は数えない） */
function callArguments(source: string, openParen: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openParen; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, index);
    }
  }
  return source.slice(openParen + 1);
}

function confirmCalls(source: string): string[] {
  const calls: string[] = [];
  // `confirmRunOrChoose` は、確認に別の道（大きいモデルへの切り替え）を
  // 並べる形（A3④）。確認であることに変わりはないので同じ約束を見る
  for (const match of source.matchAll(
    /\b(confirmRun|confirmRunOrChoose|confirmPaidUsage)\(/g
  )) {
    if (match.index === undefined) continue;
    // 宣言（`function confirmRun(`）は呼び出しではない
    const before = source.slice(Math.max(0, match.index - 20), match.index);
    if (/function\s+$/.test(before)) continue;
    calls.push(callArguments(source, match.index + match[0].length - 1));
  }
  return calls;
}

describe("確認画面に作品名を出す", () => {
  test.each(CONFIRMING_FILES)("%s", (file) => {
    const source = readFileSync(join(FEATURES, file), "utf8");
    const calls = confirmCalls(source);
    expect(calls.length, `${file} に確認が見つからない`).toBeGreaterThan(0);
    for (const args of calls) {
      // 文の中に書くか（`${work.title} の…`）、`workTitle` で渡すか
      expect(args, args.slice(0, 80)).toMatch(/work\.title|workTitle/);
    }
  });
});

/**
 * 「〇〇を開始」の記録を書く機能。**記録は確認の「実行」のあとに置く。**
 * 確認より前に書くと、キャンセルした回にも作品のログへ「開始」が残る。
 */
const STARTING_FILES = [
  "extractCharacters.ts",
  "checkTypos.ts",
  "checkContradictions.ts",
  "checkProofread.ts",
  "checkForeshadows.ts",
  "checkFactContradictions.ts",
  "checkDeviations.ts",
  "checkEpisodePlot.ts",
  "checkOpening.ts",
  "generatePlot.ts",
  "nameCheck.ts",
  "readerTargetDiagnosis.ts",
] as const;

describe("「開始」の記録は確認のあとに書く", () => {
  test.each(STARTING_FILES)("%s", (file) => {
    const source = readFileSync(join(FEATURES, file), "utf8");
    const starts = [...source.matchAll(/を開始: /g)];
    expect(starts.length, `${file} に「開始」の記録が見つからない`).toBeGreaterThan(0);
    for (const start of starts) {
      const at = start.index ?? 0;
      // その記録を含む関数の頭（直前の関数の宣言）から、記録までのあいだに
      // 確認があること
      const head = Math.max(
        source.lastIndexOf("async function ", at),
        source.lastIndexOf("function ", at)
      );
      const between = source.slice(head, at);
      expect(between, `${file}: ${source.slice(at - 20, at + 10)}`).toMatch(
        /confirmRun\(|confirmRunOrChoose\(|confirmPaidUsage\(/
      );
    }
  });
});
