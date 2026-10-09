import { AIError } from "../ai/types";
import { rateLimitWaitMs, type RateLimitWaitState } from "./extractCharacters";

/**
 * レート上限（HTTP 429）で、サーバーが示した時間だけ待って同じ呼び出しを
 * やり直す（設計書7.8「失敗の種別の見分け方」の「レート上限」の行）。
 *
 * **実際に起きた**（2026-10-10、さくら preview/Kimi-K2.6）。思考を止めて応答が
 * 1秒ほどで返るようになると、1本ずつ送っていても毎分の上限（間隔なしで5本目まで
 * 通り、6本目から 429・`Retry-After: 60`）に当たる。伏線は `rate_limited` を
 * 「待っても直らない失敗」として残りを止めていたため、作者は5チャンクごとに
 * 手で再実行することになっていた。
 *
 * 1回の待ちの決め方は人物抽出と同じ `rateLimitWaitMs`（示されなければ待たない・
 * 1回90秒まで・指定より1秒長く）。**合計の上限だけは「最後に通ってから」で
 * 数える。** 合計180秒は「1日の上限を使い切ったら待っても回復しない」ための
 * 区切りで、待つたびに通っているあいだは回復している。通算で数えると、毎分5本の
 * 上限では17チャンクの3回目の待ち（61秒×3）で諦めていた。
 *
 * VS Code に依存しない（待ち方は呼ぶ側が渡す。中止できる待ちにするため）。
 */
export interface RateLimitRetryState extends RateLimitWaitState {
  /** 最後に呼び出しが通ってから待った合計。諦めるかどうかはこれで決める */
  waitedSinceSuccessMs: number;
  /** 待っても通らずに諦めた。完了の知らせで「待った」ことを伝えるのに使う */
  gaveUp: boolean;
}

export function newRateLimitRetryState(): RateLimitRetryState {
  return { waits: 0, totalWaitedMs: 0, waitedSinceSuccessMs: 0, gaveUp: false };
}

export interface RateLimitRetryHooks {
  /** `ms` だけ待つ。中止されたら false を返す */
  sleep: (ms: number) => Promise<boolean>;
  /** 待ちに入る直前に呼ぶ（進み具合の表示とログ用）。`state` は加算後 */
  onWait?: (waitMs: number, state: RateLimitRetryState) => void;
}

export async function callWithRateLimitWait<T>(
  call: () => Promise<T>,
  state: RateLimitRetryState,
  hooks: RateLimitRetryHooks
): Promise<T> {
  for (;;) {
    try {
      const result = await call();
      state.waitedSinceSuccessMs = 0;
      return result;
    } catch (error) {
      const waitMs = rateLimitWaitMs(error, {
        waits: state.waits,
        totalWaitedMs: state.waitedSinceSuccessMs,
      });
      if (waitMs === undefined) {
        // 待ったのに回復しなかったときだけ「諦めた」と記録する。
        // 待ち時間が示されなかった 429 は、待っていないので諦めたことにしない
        if (
          error instanceof AIError &&
          error.kind === "rate_limited" &&
          state.waitedSinceSuccessMs > 0
        ) {
          state.gaveUp = true;
        }
        throw error;
      }
      state.waits++;
      state.totalWaitedMs += waitMs;
      state.waitedSinceSuccessMs += waitMs;
      hooks.onWait?.(waitMs, state);
      if (!(await hooks.sleep(waitMs))) {
        throw new AIError("処理が中止されました。", "aborted");
      }
    }
  }
}

/** 中止できる待ち（`AbortSignal` 版）。中止されたら false */
export function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
