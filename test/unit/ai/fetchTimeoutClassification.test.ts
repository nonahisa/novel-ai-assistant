import { describe, expect, test } from "vitest";
import { describeFetchFailure, isFetchTimeout } from "../../src/ai/httpClient";

/**
 * **`AbortError` だけがタイムアウトではない。**
 *
 * Nodeの `fetch`（undici）は、こちらの `AbortController` とは別に自前の
 * 待ち時間を持つ。そちらが切れると `TypeError: fetch failed` が飛び、名前が
 * `AbortError` ではないので「接続できない」（`not_running`）に落ちる。
 * **案内が真逆になる**——起動を確かめても直らず、要るのは待ち時間を延ばすか
 * 送る量を減らすことである。
 */
describe("Node自身の待ち時間切れを、接続不可と取り違えない", () => {
  test("ヘッダー待ちの上限を、時間切れと判る", () => {
    // 実測した形（2026-08-31）：TypeError: fetch failed / cause に undici の符号
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Headers Timeout Error"), {
        code: "UND_ERR_HEADERS_TIMEOUT",
      }),
    });
    expect(error.name).not.toBe("AbortError"); // ここが取り違えの入口だった
    expect(isFetchTimeout(error)).toBe(true);
  });

  test("本文待ち・接続待ちの上限も時間切れとして扱う", () => {
    for (const code of ["UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(isFetchTimeout({ cause: { code } })).toBe(true);
    }
  });

  test("本当に繋がらないときは時間切れにしない", () => {
    // ここまで時間切れにすると、「AIを起動してください」が出せなくなる
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "UND_ERR_SOCKET"]) {
      expect(
        isFetchTimeout(Object.assign(new TypeError("fetch failed"), { cause: { code } }))
      ).toBe(false);
    }
  });

  test("符号が無い・そもそもErrorでないものを、時間切れと言わない", () => {
    expect(isFetchTimeout(new Error("何か"))).toBe(false);
    expect(isFetchTimeout({ cause: {} })).toBe(false);
    expect(isFetchTimeout({ cause: null })).toBe(false);
    expect(isFetchTimeout(undefined)).toBe(false);
    expect(isFetchTimeout(null)).toBe(false);
    expect(isFetchTimeout("fetch failed")).toBe(false);
  });

  test("文言では判定しない（0.28.4と同じ理由）", () => {
    // メッセージを直した瞬間に効かなくなる判定を作らない
    expect(isFetchTimeout(new TypeError("fetch failed"))).toBe(false);
    expect(isFetchTimeout({ message: "Headers Timeout Error" })).toBe(false);
  });
});

/**
 * **「fetch failed」の5文字だけをログに残さない**（CLAUDE.md 規則5）。
 *
 * Nodeの `fetch` は失敗をすべて `TypeError: fetch failed` にまとめるので、
 * `err.message` だけでは「落ちた」「切れた」「時間切れ」の区別が付かない。
 * 作者のログ（2026-08-31 00:03）で実際に追えなくなった。
 */
describe("fetchの失敗は、符号まで残す", () => {
  test("cause の符号と説明を添える", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Headers Timeout Error"), {
        code: "UND_ERR_HEADERS_TIMEOUT",
      }),
    });
    const described = describeFetchFailure(error);
    expect(described).toContain("fetch failed");
    // **符号こそが手がかり。** これが無いと後から原因を追えない
    expect(described).toContain("UND_ERR_HEADERS_TIMEOUT");
    expect(described).toContain("Headers Timeout Error");
  });

  test("cause が無ければ、そのままの文言だけ", () => {
    expect(describeFetchFailure(new Error("接続が拒否されました"))).toBe(
      "接続が拒否されました"
    );
  });

  test("同じ文言を二度並べない", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED", message: "fetch failed" },
    });
    expect(describeFetchFailure(error)).toBe("fetch failed / ECONNREFUSED");
  });

  test("Errorでないものを渡されても落ちない", () => {
    expect(describeFetchFailure(undefined)).toBe("不明な失敗");
    expect(describeFetchFailure(null)).toBe("不明な失敗");
    expect(describeFetchFailure("何か")).toBe("何か");
  });
});
