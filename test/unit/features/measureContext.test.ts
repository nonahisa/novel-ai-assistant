import { describe, expect, test } from "vitest";
import {
  countErrorAsTooLong,
  describeProbeStop,
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

  /**
   * **12種別すべてを表に並べる**（作者の依頼、2026-09-13）。
   *
   * 0.61.0 までは「`aborted` と `timeout` 以外は全部数える」という書き方
   * だったので、**新しい種別が増えるたびに黙って「入らない」側へ入った。**
   * 実機の Gemini は `rate_limited` を6回数えられ、1,024k トークンを申告して
   * いるのに実効の上限が 186,434字で固定された——測っていたのは長さではなく
   * 無料枠の窓である。
   *
   * この表は `Record<AIError["kind"], boolean>` なので、**種別が増えたら
   * 型検査が落ちる。** 追加した人が、ここで扱いを決めることになる。
   */
  const BY_KIND: Record<AIError["kind"], boolean> = {
    // 「長すぎて断られた」の実績があるのはこの2つだけ。さくらの
    // gpt-oss-120b は上限超えを400で返し、`bad_response` に落ちていた
    bad_response: true,
    unknown: true,
    // ここから下は、どれも**長さについて何も言っていない**
    not_running: false,
    model_not_found: false,
    timeout: false,
    authentication_failed: false,
    permission_denied: false,
    insufficient_credit: false,
    model_load_failed: false,
    context_overflow: false,
    rate_limited: false,
    aborted: false,
  };

  test("数えてよいのは bad_response と unknown だけ（12種別を表で見る）", () => {
    // 数が変わったら、表の側も見直したというしるしになる
    expect(Object.keys(BY_KIND)).toHaveLength(12);

    for (const [kind, expected] of Object.entries(BY_KIND)) {
      expect(
        countErrorAsTooLong(true, new AIError("失敗", kind as AIError["kind"])),
        kind
      ).toBe(expected);
    }
  });

  test("一度も通っていなければ、どの種別でも数えない", () => {
    for (const kind of Object.keys(BY_KIND)) {
      expect(
        countErrorAsTooLong(false, new AIError("失敗", kind as AIError["kind"])),
        kind
      ).toBe(false);
    }
  });

  /**
   * **分あたりの上限を数えない**（実機、2026-09-13）。
   *
   * 待てば回復するものを「このモデルはここまでしか読めない」という記録に
   * 化けさせてはいけない。回復を試みる道は `runMeasurement` の中にある。
   *
   * **60秒待ってもなお通らない長さは、そこで短いほうへ降りる**（作者の
   * 裁定、2026-09-13夜）。ただし**それはこの関数の仕事ではない。**
   * `runMeasurement` の別の経路で降り、降りた回数を数えて台帳へ印
   * （`contextLimitedByRate`）を残す。ここを `true` にして済ませると、
   * **「長すぎた」と「枠を使い切った」が同じ数に混ざって理由が消える。**
   */
  test("分あたりの上限は数えない（待てば回復するものを上限にしない）", () => {
    const limited = new AIError("レート上限です。", "rate_limited");

    expect(countErrorAsTooLong(true, limited)).toBe(false);
  });

  test("残高切れ・鍵の失効も数えない（長さとは関係が無い）", () => {
    for (const kind of [
      "insufficient_credit",
      "authentication_failed",
      "permission_denied",
      "not_running",
    ] as const) {
      expect(countErrorAsTooLong(true, new AIError("失敗", kind)), kind).toBe(
        false
      );
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

/**
 * 探索を打ち切ったときの文面（作者の依頼、2026-09-13）。
 *
 * **打ち切る理由が増えたので、入れ物を一般化した。** 0.61.0 は時間切れ
 * 専用の形（`timeoutStop`）で持っていたが、分あたりの上限・残高切れ・
 * 鍵の失効でも打ち切るようになり、理由ごとに言うことが違う。
 *
 * **どの理由でも「読めなかった」とは言わない。** 分かったのは
 * 「測れなかった」だけで、打つ手（待ち時間を延ばす・しばらく待つ・
 * 残高を足す）はまだ残っている。
 */
describe("打ち切った理由の文面", () => {
  test("打ち切っていなければ何も言わない", () => {
    expect(describeProbeStop(undefined)).toBe("");
  });

  test("時間切れの文は、これまでと同じ", () => {
    // 0.61.0 で作者が読んだ文である。理由が増えても、ここは動かさない
    const text = describeProbeStop({
      chars: 186_434,
      reason: "timeout",
      seconds: 1200,
    });

    expect(text).toContain("186,434 字で時間切れになりました");
    expect(text).toContain("待ち時間 1200 秒");
    expect(text).toContain("もっと読める可能性があります");
  });

  /*
    **分あたりの上限に当たっただけでは打ち切らない**（作者の裁定、
    2026-09-13夜）。降りて探索を続ける。打ち切るのは**降りた回数が蓋に
    届いたとき**だけで、そのとき作者へ言うべきことも違う——
    「待てば伸びる」ではなく「**これ以上は待たない。時間を置いてやり直して**」
    である。
  */
  test("降りきれなかったときは、「これ以上は待たない」と言う", () => {
    const text = describeProbeStop({
      chars: 20_803,
      reason: "rate_limit_floor",
      seconds: 300,
    });

    expect(text).toContain("分あたりの上限");
    expect(text).toContain("300 秒待ちました");
    expect(text).toContain("これ以上は待たずに、ここまでの結果を出しています");
    expect(text).toContain("時間を置いてから測り直す");
    // **「これより長い長さは測れていません」とは言わない。**
    // 降りながら測ったので、その下は実際に測ってある
    expect(text).not.toContain("これより長い長さは測れていません");
  });

  test("そのほかの止まり方は、返ってきた本文をそのまま見せる", () => {
    // **エラーの本文を捨てない**（CLAUDE.md 規則5）。残高切れなのか鍵なのかは
    // 向こうの言葉にしか書いていない
    const text = describeProbeStop({
      chars: 32_000,
      reason: "fatal",
      detail: "credit balance is too low",
    });

    expect(text).toContain("32,000 字で「credit balance is too low」が返り");
    expect(text).toContain("そこで測定を止めました");
    expect(text).toContain("これより長い長さは測れていません");
  });

  test("**どの理由でも「読めない」とは言わない**", () => {
    const texts = [
      describeProbeStop({ chars: 100, reason: "timeout", seconds: 60 }),
      describeProbeStop({ chars: 100, reason: "rate_limit_floor", seconds: 300 }),
      describeProbeStop({ chars: 100, reason: "fatal", detail: "残高不足" }),
    ];

    for (const text of texts) {
      // 分かったのは「測れなかった」だけである。言い換えない
      expect(text, text).not.toContain("読めません");
      expect(text, text).not.toContain("読めない");
      expect(text, text).not.toContain("読めませんでした");
    }
  });

  /*
    **「測れていません」と言ってよいのは、本当に測っていないときだけ。**

    時間切れと致命的な失敗は、その長さで止まってその先を試していない。
    一方、蓋まで降りた測定は**降りながら二分探索で詰めている**ので、
    下の範囲は実際に測ってある。ここで「測れていません」と言うと、
    測った値を自分で否定することになる。
  */
  test("止めた理由によって、「測れていません」と言うかどうかが変わる", () => {
    expect(
      describeProbeStop({ chars: 100, reason: "timeout", seconds: 60 })
    ).toContain("測れていません");
    expect(
      describeProbeStop({ chars: 100, reason: "fatal", detail: "残高不足" })
    ).toContain("測れていません");

    const floor = describeProbeStop({
      chars: 100,
      reason: "rate_limit_floor",
      seconds: 300,
    });
    expect(floor).not.toContain("測れていません");
    expect(floor).toContain("ここまでの結果を出しています");
  });
});
