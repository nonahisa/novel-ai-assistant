import { describe, expect, test } from "vitest";
import {
  countErrorAsTooLong,
  doubledTimeoutSeconds,
} from "../../src/features/measureContext";
import { AIError } from "../../src/ai/types";
import { MAX_TIMEOUT_SECONDS } from "../../src/core/modelTuning";

/**
 * 「AIが実際に読める長さを測る」の、エラーの数え方（作者のログ、
 * 2026-08-30）。
 *
 * 4,000〜128,000字は「両方」返っていたのに、次の183,239字で400が返った
 * ところで測定が終わり、「測定に失敗しました」と出た。作者はこれを
 * 「さくらもつながりません」と受け取った。**本当は「183,239字は入らない」と
 * 数えて、128,000との間を詰めるべき場面である**（設計書6.27.11）。
 *
 * プロバイダ側でも上限超えを `context_overflow` に分類したが、
 * ここは**それをすり抜けた失敗のための保険**である。
 */
describe("エラーを「入らなかった」と数えてよいか", () => {
  const overflow = new AIError("長すぎます", "bad_response", "exceeds context");

  test("短い長さで一度でも通っていれば、入らなかったと数える", () => {
    // 通ったことがあるなら、接続も鍵も残高も生きている。
    // そこから長くして落ちたのだから、原因は長さのほうである
    expect(countErrorAsTooLong(true, overflow)).toBe(true);
  });

  test("一度も通っていなければ、失敗として報告する", () => {
    // ここを緩めると、鍵の間違いや残高不足を「入らない」と誤魔化して
    // 「実効の上限は0字です」という無意味な結果を出す
    expect(countErrorAsTooLong(false, overflow)).toBe(false);
  });

  test("作者が止めたときは数えない", () => {
    const aborted = new AIError("処理が中止されました。", "aborted");

    expect(countErrorAsTooLong(true, aborted)).toBe(false);
  });

  test("AIの失敗でない例外は、数えずにそのまま報告する", () => {
    // 想定していない壊れ方を「長すぎた」で覆い隠さない
    expect(countErrorAsTooLong(true, new Error("何かが壊れた"))).toBe(false);
  });

  test("種別を問わず数える（種別の当て推量をしない）", () => {
    // どの種別で返すかはAI側の都合で変わる。通ったあとに落ちたという
    // 事実のほうを信じる（CLAUDE.md 規則5「エラー文から原因を当てにいかない」）
    for (const kind of ["bad_response", "timeout", "unknown"] as const) {
      expect(countErrorAsTooLong(true, new AIError("失敗", kind))).toBe(true);
    }
  });
});

/**
 * 時間切れになった回だけ、待ち時間を延ばして測り直す（作者の依頼、
 * 2026-08-30「タイムアウト問題が出たら、その設定も調整してみるのは
 * どうでしょうか？」）。
 *
 * **時間切れは「長すぎた」とは限らない。** 待ち時間の設定がそのモデルに
 * 合っていないだけかもしれず、そのまま「入らない」と数えると実効の上限を
 * 実際より短く見積もる。
 */
describe("測り直すときに延ばす待ち時間", () => {
  test("倍にする", () => {
    // 何秒あれば足りるかは分からないので、当て推量の刻みを持ち込まない
    expect(doubledTimeoutSeconds(180)).toBe(360);
    expect(doubledTimeoutSeconds(240)).toBe(480);
  });

  test("上限を超えるぶんは切り詰める", () => {
    expect(doubledTimeoutSeconds(400)).toBe(MAX_TIMEOUT_SECONDS);
    expect(doubledTimeoutSeconds(400)).toBe(600);
  });

  test("すでに上限なら、延ばさない（undefined）", () => {
    // ここで倍にし続けると、測定が終わらなくなる
    expect(doubledTimeoutSeconds(600)).toBeUndefined();
    expect(doubledTimeoutSeconds(900)).toBeUndefined();
  });

  test("読めない秒数では延ばさない", () => {
    for (const seconds of [0, -1, Number.NaN]) {
      expect(doubledTimeoutSeconds(seconds), String(seconds)).toBeUndefined();
    }
  });
});
