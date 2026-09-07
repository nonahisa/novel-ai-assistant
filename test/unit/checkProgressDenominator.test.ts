import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 進捗の分母は「実際にAIへ送る件数」にする（作者の指摘、2026-09-06）。
 *
 * 実機で起きたこと——「7チャンク中 1 件を処理します（処理済み 6 件は
 * スキップ）」と断ったうえで、進捗は「誤字脱字を検知しています… **1/7**
 * チャンク」と出た。**実際に動くのは1件なので、3分間ずっと 1/7 のまま
 * 変わらない。** 作者からは止まったように見える。
 *
 * 直し方は2つで対になっている。
 *
 * 1. 分母を未処理の件数（`pending`）にする
 * 2. **キャッシュ命中では分子を進めない。** ここを忘れると、かつて
 *    「11/2」と分子が分母を超えた形に戻る（0.28.13）
 *
 * **各機能を丸ごと走らせる試験は無い**（AI・ファイル・進捗の差し替えが
 * 要るため）。ここでは、書いてあるコードの形で見る。
 */

/** チャンクごとに送る検知（話ごとに送る逸脱だけは、下で別に見る） */
const FEATURES: readonly string[] = [
  "checkTypos.ts",
  "checkProofread.ts",
  "checkContradictions.ts",
  "checkForeshadows.ts",
];

/**
 * キャッシュ命中で分子を進めていないか。
 *
 * 書き方は2通りある。**どちらでも「進めない」ことに変わりはない。**
 * - 早く抜ける形（`checkTypos`）… `if (cached) { … continue; }` の中に
 *   `done++` が無い
 * - 送ったときだけ数える形（ほか）… `if (cached === undefined) { … }` で囲う
 */
function skipsCachedInCount(source: string): boolean {
  if (source.includes("if (cached === undefined) {")) return true;

  const head = source.indexOf("if (cached) {");
  if (head < 0) return false;
  const branch = source.slice(head, source.indexOf("continue;", head));
  return !branch.includes("done++");
}

function read(file: string): string {
  return readFileSync(resolve(__dirname, "../../src/features", file), "utf8");
}

describe("分母は、実際にAIへ送る件数にする", () => {
  for (const file of FEATURES) {
    test(`${file} は、未処理の件数を分母に置く`, () => {
      const source = read(file);
      // `let total = pending.length` / `let chunksTotal = pending.length`
      expect(source).toMatch(/let (chunks)?[Tt]otal = pending\.length/);
    });

    test(`${file} は、キャッシュ命中では分子を進めない`, () => {
      // 進めると分子が分母を超える（処理済み9件・未処理2件で「11/2」）
      expect(skipsCachedInCount(read(file))).toBe(true);
    });

    test(`${file} は、飛ばした件数を画面へ添える`, () => {
      // 分母が小さくなった断り。無いと「一部しか見ていない」に読める
      const source = read(file);
      expect(source).toMatch(/onProgress\?\.\([^)]*skipped/i);
    });
  }

  /**
   * プロット逸脱は、チャンクではなく**話ごと**に送る。数え方は同じで、
   * 分母は「実際に送る話数」である。
   */
  test("checkDeviations.ts も、実際に送る話数を分母に置く", () => {
    const source = read("checkDeviations.ts");

    expect(source).toContain("if (cached === undefined) {");
    expect(source).toContain("${episodesDone}/${pending.length}");
    expect(source).toMatch(/onProgress\?\.\(\s*episodesDone,\s*pending\.length/);
  });
});

/**
 * 進み具合を運ぶ口（`views/progress.ts` の `CheckProgress`）は、
 * 飛ばした件数まで運べなければならない。**分母だけ小さくして数を
 * 伏せると、本文の一部しか見ていないように読める。**
 */
describe("飛ばした件数を運ぶ口", () => {
  test("CheckProgress が、飛ばした件数を受けられる", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/views/progress.ts"),
      "utf8"
    );

    expect(source).toContain("skipped?: number");
  });
});
