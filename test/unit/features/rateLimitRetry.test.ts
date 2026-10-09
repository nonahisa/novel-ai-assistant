import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AIError } from "../../../src/ai/types";
import {
  callWithRateLimitWait,
  newRateLimitRetryState,
  rateLimitGiveUpNote,
  rateLimitWaitHooks,
} from "../../../src/features/rateLimitRetry";

/*
  **レート上限（HTTP 429）で、示された時間だけ待って同じチャンクをやり直す。**

  実際に起きた（2026-10-10 の〔AIの測定〕、さくら preview/Kimi-K2.6）。
  思考を止めて（0.100.6）応答が1秒ほどで返るようになったら、伏線の回収確認が
  17チャンク中 8〜11 件を `rate limit exceeded` で落とした。さくらへ直に
  探りを入れると、**間隔なしの5本目までは通り、6本目から 429・`Retry-After: 60`**、
  61秒待てば通った。製品の伏線は `rate_limited` を「待っても直らない失敗」として
  1回目で残りを止めていたので、作者が使えば5チャンクごとに手で再実行することになる。

  待ちは人物抽出と同じ決まり（`rateLimitWaitMs`：1回90秒まで・示されなければ
  待たない）。**ただし合計の上限は「最後に通ってから」で数える。** 抽出の
  合計180秒は「1日の上限を使い切ったら待っても回復しない」ための区切りで、
  待つたびに通っている間は回復している。通算で数えると、毎分5本の上限では
  17チャンクで3回目の待ち（61秒×3＝183秒）が上限を越え、ここで諦めていた。
*/

/** さくらの上限を真似た作り物：窓（60秒）の中で5本まで。越えたら 429・待ち60秒 */
function sakuraLikeServer(clock: { now: number }) {
  let windowStart = -Infinity;
  let used = 0;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async call(): Promise<string> {
      calls++;
      if (clock.now - windowStart >= 60_000) {
        windowStart = clock.now;
        used = 0;
      }
      if (used >= 5) {
        throw new AIError(
          "さくらのAIのレート上限に達しました。しばらく待ってから再実行してください。",
          "rate_limited",
          '{"error":{"message":"rate limit exceeded"}}',
          60_000
        );
      }
      used++;
      clock.now += 1_000;
      return "ok";
    },
  };
}

describe("レート上限で待ってやり直す", () => {
  test("毎分5本の上限でも、17チャンクを最後まで通す", async () => {
    const clock = { now: 0 };
    const server = sakuraLikeServer(clock);
    const state = newRateLimitRetryState();
    const sleep = vi.fn(async (ms: number) => {
      clock.now += ms;
      return true;
    });
    const results: string[] = [];
    for (let i = 0; i < 17; i++) {
      results.push(
        await callWithRateLimitWait(() => server.call(), state, { sleep })
      );
    }
    expect(results).toHaveLength(17);
    expect(state.waits).toBe(3);
    // サーバーの指定ちょうどだと際どいので1秒足して待つ（抽出と同じ）
    expect(sleep).toHaveBeenCalledWith(61_000);
    expect(state.gaveUp).toBe(false);
  });

  test("待っても通らないまま合計180秒を越えたら諦め、レート上限の失敗として返す", async () => {
    const state = newRateLimitRetryState();
    const sleep = vi.fn(async () => true);
    const always429 = async (): Promise<string> => {
      throw new AIError("上限", "rate_limited", "", 60_000);
    };
    await expect(
      callWithRateLimitWait(always429, state, { sleep })
    ).rejects.toMatchObject({ kind: "rate_limited" });
    // 61秒×2＝122秒までは待ち、3回目（183秒）で諦める
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(state.gaveUp).toBe(true);
  });

  test("待ち時間が示されなければ待たない（当て推量で待つと終わりが読めない）", async () => {
    const state = newRateLimitRetryState();
    const sleep = vi.fn(async () => true);
    await expect(
      callWithRateLimitWait(
        async () => {
          throw new AIError("上限", "rate_limited");
        },
        state,
        { sleep }
      )
    ).rejects.toMatchObject({ kind: "rate_limited" });
    expect(sleep).not.toHaveBeenCalled();
    expect(state.gaveUp).toBe(false);
  });

  test("レート上限以外の失敗は待たずにそのまま返す", async () => {
    const state = newRateLimitRetryState();
    const sleep = vi.fn(async () => true);
    await expect(
      callWithRateLimitWait(
        async () => {
          throw new AIError("鍵", "authentication_failed", "", 60_000);
        },
        state,
        { sleep }
      )
    ).rejects.toMatchObject({ kind: "authentication_failed" });
    expect(sleep).not.toHaveBeenCalled();
  });

  test("待っている間に中止されたら、中止として返す", async () => {
    const state = newRateLimitRetryState();
    const call = vi.fn(async (): Promise<string> => {
      throw new AIError("上限", "rate_limited", "", 60_000);
    });
    await expect(
      callWithRateLimitWait(call, state, { sleep: async () => false })
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(call).toHaveBeenCalledOnce();
  });

  test("待つたびに、何秒待つかを知らせる（黙って止まって見えないように）", async () => {
    const clock = { now: 0 };
    const server = sakuraLikeServer(clock);
    const state = newRateLimitRetryState();
    const onWait = vi.fn();
    for (let i = 0; i < 6; i++) {
      await callWithRateLimitWait(() => server.call(), state, {
        sleep: async (ms) => {
          clock.now += ms;
          return true;
        },
        onWait,
      });
    }
    expect(onWait).toHaveBeenCalledOnce();
    expect(onWait.mock.calls[0]?.[0]).toBe(61_000);
  });
});

/**
 * 伏線の検知と回収確認は、AIを呼ぶ所でこの待ちを通す。
 *
 * **1か所でも素の `provider.generate` に戻ると、5チャンクごとに止まる形へ戻る。**
 */
describe("伏線はレート上限で待つ", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/features/checkForeshadows.ts"),
    "utf8"
  );

  test("検知と回収確認の2か所とも、待ちを通して呼ぶ", () => {
    const wrapped = source.match(/callWithRateLimitWait\(/g) ?? [];
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
  });
});

/*
  **同じ決まりを機能ごとに写さない。** 推敲・矛盾検知・事実の矛盾・人物抽出・誤字脱字は、
  どれも AI をチャンクごとに呼ぶ。1か所でも素の `provider.generate` や、
  待ちを自前で書いた形に戻ると、5チャンクごとに止まる（または通算で諦める）形へ戻る。
*/
function featureSource(name: string): string {
  return readFileSync(
    resolve(__dirname, `../../../src/features/${name}.ts`),
    "utf8"
  );
}

describe("チャンクごとにAIを呼ぶ機能は、レート上限の待ちを共通の部品で通す", () => {
  test.each(["checkProofread", "checkContradictions", "checkFactContradictions"])(
    "%s は、チャンクの呼び出しを待ちに通し、諦めた前置きも付ける",
    (name) => {
      const source = featureSource(name);
      expect(source).toContain("callWithRateLimitWait(");
      expect(source).toContain("newRateLimitRetryState()");
      expect(source).toContain("rateLimitGiveUpNote(");
    }
  );

  test.each(["extractCharacters", "checkTypos"])(
    "%s は、待ちを自前で書かず、共通の部品で「最後に通ってから」数える",
    (name) => {
      const source = featureSource(name);
      expect(source).toContain("callWithRateLimitWait(");
      // 通算で数える旧い書き方（呼び出しの外で totalWaitedMs を足す）が残っていない
      expect(source).not.toMatch(/rateLimit\.totalWaitedMs\s*\+=/);
      expect(source).not.toMatch(/rateLimitWaitMs\(error/);
    }
  );
});

describe("待ちの表示と諦めた前置き", () => {
  test("待つ文言は、進み具合・秒数・回数・合計を含む", async () => {
    const reports: string[] = [];
    const logs: string[] = [];
    const state = newRateLimitRetryState();
    const hooks = rateLimitWaitHooks({
      sleep: async () => true,
      report: (m) => reports.push(m),
      log: (m) => logs.push(m),
      position: () => "3/17",
    });
    let first = true;
    await callWithRateLimitWait(
      async () => {
        if (first) {
          first = false;
          throw new AIError("上限", "rate_limited", "", 60_000);
        }
        return "ok";
      },
      state,
      hooks
    );
    expect(reports[0]).toBe(
      "3/17  レート上限のため 61 秒待っています（1回目 / 合計 61 秒）"
    );
    expect(logs[0]).toContain("61 秒待っています");
  });

  test("諦めていなければ前置きは空、諦めたら待った秒数を書く", () => {
    const state = newRateLimitRetryState();
    expect(rateLimitGiveUpNote(state)).toBe("");
    state.gaveUp = true;
    state.waitedSinceSuccessMs = 122_000;
    expect(rateLimitGiveUpNote(state)).toContain("合計 122 秒待ちましたが");
  });
});
