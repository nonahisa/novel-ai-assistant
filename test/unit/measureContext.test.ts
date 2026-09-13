import { describe, expect, test } from "vitest";
import {
  countErrorAsTooLong,
  doubledTimeoutSeconds,
  estimateProbeTokens,
} from "../../src/features/measureContext";
import { AIError } from "../../src/ai/types";
import {
  MAX_TIMEOUT_SECONDS,
  PROBE_MAX_TIMEOUT_SECONDS,
} from "../../src/core/modelTuning";
import {
  probeCharsToTokens,
  worstCaseProbeChars,
} from "../../src/core/contextProbe";

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
    for (const kind of ["bad_response", "rate_limited", "unknown"] as const) {
      expect(countErrorAsTooLong(true, new AIError("失敗", kind))).toBe(true);
    }
  });

  /**
   * **時間切れだけは別**（作者の依頼、2026-09-13）。
   *
   * 時間切れが言っているのは「待っているあいだに返らなかった」であって、
   * 「入らなかった」ではない。**遅いのか長すぎるのかが区別できていない。**
   * 数えてしまうと、遅いだけのモデルで実効の上限が実際より短く出る——
   * 実機の gemma4:12b は4回の時間切れを「入らない」と数えられ、
   * 実効の上限が 194,288字（天井は 362,191字）で止まった。
   */
  test("時間切れは数えない（測れなかっただけで、読めないとは限らない）", () => {
    const timeout = new AIError("時間切れです。", "timeout");

    expect(countErrorAsTooLong(true, timeout)).toBe(false);
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

  /**
   * **測定のあいだだけ、上限が別にある**（作者の依頼、2026-09-13）。
   *
   * 0.60.1 で天井が倍近くへ広がり、1回に送る量が増えた。実機の
   * gemma4:12b は**台帳が既に600秒**だったので、ふだんの上限で挟むと
   * **1秒も延ばせず**、時間切れがそのまま結果に化けていた。
   *
   * ふだんの呼び出しの上限（600秒）は動かさない。測定は1回きりで作者が
   * 結果を待っている場面、ふだんの呼び出しは何十回も走って止まると作業が
   * 詰まる場面——同じ上限でよい理由が無い。
   */
  test("測定用の上限を渡せば、600秒からでも延ばせる", () => {
    // これが実機で詰まっていたところ。引数が無いと undefined のままだった
    expect(doubledTimeoutSeconds(600, PROBE_MAX_TIMEOUT_SECONDS)).toBe(1200);
    expect(doubledTimeoutSeconds(900, PROBE_MAX_TIMEOUT_SECONDS)).toBe(
      PROBE_MAX_TIMEOUT_SECONDS
    );
  });

  test("測定用の上限も、超えては延ばさない", () => {
    expect(
      doubledTimeoutSeconds(
        PROBE_MAX_TIMEOUT_SECONDS,
        PROBE_MAX_TIMEOUT_SECONDS
      )
    ).toBeUndefined();
  });

  test("**ふだんの上限は600秒のまま**（測定用の線を持ち込まない）", () => {
    // 引数を省いたときの動きは、これまでと1秒も変わらない
    expect(MAX_TIMEOUT_SECONDS).toBe(600);
    expect(doubledTimeoutSeconds(600)).toBeUndefined();
    expect(doubledTimeoutSeconds(400)).toBe(600);
  });
});

/**
 * 有料AIに見せる送信量の見込み。
 *
 * **測り直しの1回を勘定に入れる。** 時間切れになった回は同じ長さを
 * もう一度送るので、探索の枝をたどっただけの `worstCaseProbeChars` では
 * 足りない。**見せた額より多く請求される側にずれる**のがいちばん悪い
 * （記録82で同じ判断をしている——「2倍だと少なく見せる」）。
 */
describe("送信量の見込み", () => {
  const ceiling = 90_000;

  test("測り直しの1回を足す（探索のぶんだけでは足りない）", () => {
    const searchOnly = probeCharsToTokens(worstCaseProbeChars(ceiling));

    expect(estimateProbeTokens(ceiling)).toBeGreaterThan(searchOnly);
  });

  test("足すのは、いちばん長い1回ぶん", () => {
    // 測り直すのは**同じ長さ**をもう一度である。最悪でも上限の長さで
    // 1回なので、それ以上を見込むと今度は多すぎて実行をためらわせる
    expect(estimateProbeTokens(ceiling)).toBe(
      probeCharsToTokens(worstCaseProbeChars(ceiling) + ceiling)
    );
  });
});
