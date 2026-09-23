import { describe, expect, test } from "vitest";
import {
  decideChunkSize,
  planChunkBudget,
  TOKENS_PER_CHAR,
} from "../../src/core/chunker";
import {
  WORLDVIEW_MAX_CHARS,
  worldviewMaxChars,
} from "../../src/core/worldviewSelect";
import {
  PAST_SCENE_MAX_CHARS,
  pastSceneMaxChars,
} from "../../src/core/pastSceneSelect";
import {
  CHARS_PER_TOKEN,
  referenceBudgetChars,
  TOKENS_PER_CHAR as TOKENS_PER_CHAR_SOURCE,
} from "../../src/core/sizeBudget";

/**
 * 大きさの予算の共通化・第1段（設計書6.77）の**同値の固定**。
 *
 * ここは「良い値か」を問うテストではない。**共通化の前後で1字も変わらない**
 * ことだけを見る。期待値は共通化に手を付ける前の実装から手で写したもので、
 * この表が動いたときは共通化が挙動を変えたということである（＝やり直し）。
 *
 * 第2段（食い違いの解消）で値を変えるときは、**その版で意図して**この表を
 * 書き換える。黙って合わせない。
 */

describe("字↔トークン換算の値は変わらない", () => {
  test("TOKENS_PER_CHAR は 1/0.7 のまま", () => {
    // 逆数を掛け直したときに桁落ちしていないこと（`1/0.7` と厳密に同じ）
    expect(TOKENS_PER_CHAR).toBe(1 / 0.7);
    expect(TOKENS_PER_CHAR).toBe(1.4285714285714286);
  });

  test("逆数も 0.7 のまま、掛け合わせて1に戻る", () => {
    expect(CHARS_PER_TOKEN).toBe(0.7);
    expect(TOKENS_PER_CHAR_SOURCE).toBe(1 / CHARS_PER_TOKEN);
  });

  test("`chunker` からの再exportは、定義元と同じものを指す", () => {
    // 呼び出し側を書き換えずに済ませるための互換経路（設計書6.77）。
    // ここが別物になると、換算が2つある状態へ逆戻りする
    expect(TOKENS_PER_CHAR).toBe(TOKENS_PER_CHAR_SOURCE);
  });
});

/**
 * 「モデル比◯%・頭打ち◯字の小さい方」型の上限。
 *
 * 世界観（25%／30,000字）と過去場面（10%／6,000字）は同じ形の式を
 * 別々に書いていた。共通化しても、境界のどこでも同じ値を返すこと。
 */
describe("参照資料の上限（モデル比＋頭打ち）", () => {
  test.each<[number | undefined, number]>([
    [undefined, 30000],
    [0, 30000],
    [-1, 30000],
    [1024, 179],
    [4096, 716],
    [8192, 1433],
    [32768, 5734],
    [65536, 11468],
    [131072, 22937],
    [262144, 30000],
  ])("worldviewMaxChars(%s) は %i 字", (contextWindow, expected) => {
    expect(worldviewMaxChars(contextWindow)).toBe(expected);
  });

  test.each<[number | undefined, number]>([
    [undefined, 6000],
    [0, 6000],
    [-1, 6000],
    [1024, 71],
    [4096, 286],
    [8192, 573],
    [32768, 2293],
    [65536, 4587],
    [131072, 6000],
    [262144, 6000],
  ])("pastSceneMaxChars(%s) は %i 字", (contextWindow, expected) => {
    expect(pastSceneMaxChars(contextWindow)).toBe(expected);
  });

  /**
   * 共通化した式が、2つの呼び出し側と**同じ値**を返すこと。
   *
   * 上の2つの表は「実装が変わっていない」ことを見るが、こちらは
   * 「呼び出し側が本当に共通の式を通っている」ことを見る。
   * 片方だけ元の式へ戻すような直し方をすると、ここが落ちる。
   */
  test.each([undefined, 0, -1, 1, 1024, 4096, 8192, 32768, 65536, 131072, 262144])(
    "referenceBudgetChars は2つの呼び出し側と同値（contextWindow=%s）",
    (contextWindow) => {
      expect(referenceBudgetChars(contextWindow, 0.25, WORLDVIEW_MAX_CHARS)).toBe(
        worldviewMaxChars(contextWindow)
      );
      expect(referenceBudgetChars(contextWindow, 0.1, PAST_SCENE_MAX_CHARS)).toBe(
        pastSceneMaxChars(contextWindow)
      );
    }
  );

  test("コンテキスト長が分からなければ、頭打ちを返す（0にしない）", () => {
    // 「分からない」を「使ってはいけない」と読み替えると、モデル情報を
    // 取れないプロバイダで参照資料が丸ごと消える
    expect(referenceBudgetChars(undefined, 0.25, 30000)).toBe(30000);
    expect(referenceBudgetChars(Number.NaN, 0.25, 30000)).toBe(30000);
  });
});

/**
 * チャンクの字数。
 *
 * ここが1字でも動くと**チャンクの切れ目が変わり、処理済みキャッシュが
 * 全部飛ぶ**（内容ハッシュが鍵のため）。有料AIなら費用に直結する。
 */
describe("チャンク字数の決め方", () => {
  test.each<[number, number]>([
    [2048, 1500],
    [4096, 1500],
    [8192, 2006],
    [16384, 4013],
    [32768, 8027],
    [65536, 16055],
    [131072, 20000],
    [262144, 20000],
  ])("decideChunkSize(%i) は %i 字", (contextWindow, expected) => {
    expect(decideChunkSize(contextWindow)).toBe(expected);
  });

  test.each<
    [
      { contextWindow: number; overheadChars: number; outputTokens: number; requestedChars: number },
      number,
      "requested" | "shrunk_to_fit" | "minimum",
    ]
  >([
    // 余裕がある（望みどおり）
    [
      { contextWindow: 131072, overheadChars: 12000, outputTokens: 8192, requestedChars: 20000 },
      20000,
      "requested",
    ],
    [
      { contextWindow: 65536, overheadChars: 12000, outputTokens: 8192, requestedChars: 20000 },
      20000,
      "requested",
    ],
    // 固定費に押されて縮む
    [
      { contextWindow: 32768, overheadChars: 12000, outputTokens: 8192, requestedChars: 20000 },
      4729,
      "shrunk_to_fit",
    ],
    [
      { contextWindow: 32768, overheadChars: 11000, outputTokens: 4096, requestedChars: 20000 },
      8245,
      "shrunk_to_fit",
    ],
    [
      { contextWindow: 16384, overheadChars: 5000, outputTokens: 2048, requestedChars: 20000 },
      4577,
      "shrunk_to_fit",
    ],
    // 縮めても足りず、下限で止まる
    [
      { contextWindow: 16384, overheadChars: 11000, outputTokens: 4096, requestedChars: 8000 },
      1500,
      "minimum",
    ],
    [
      { contextWindow: 8192, overheadChars: 11000, outputTokens: 4096, requestedChars: 6000 },
      1500,
      "minimum",
    ],
    // 望みが下限より小さいときは、下限へ「上げ」ない
    [
      { contextWindow: 4096, overheadChars: 5000, outputTokens: 2048, requestedChars: 1000 },
      1000,
      "minimum",
    ],
  ])("planChunkBudget(%o) は %i 字（%s）", (options, chars, reason) => {
    expect(planChunkBudget(options)).toEqual({ chunkChars: chars, reason });
  });
});
