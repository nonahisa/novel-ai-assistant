import { AIError } from "../ai/types";

/** 1回あたりの待機時間の上限。これを超える指定なら待たずに失敗として扱う */
export const MAX_RATE_LIMIT_WAIT_MS = 90_000;

/**
 * 1回の抽出で待ってよい合計時間。
 *
 * 無料枠には毎分の制限とは別に1日あたりの上限があり、
 * そちらを使い切ると待っても回復しない。それでも待ち続けると
 * 何十分も終わらない処理になる。
 * 回数ではなく**合計時間**で区切るのは、1回の待ち時間が
 * サーバーの都合で変わるため、回数では長さを見積もれないから。
 */
export const MAX_TOTAL_RATE_LIMIT_WAIT_MS = 180_000;

export interface RateLimitWaitState {
  waits: number;
  totalWaitedMs: number;
}

/**
 * レート上限で待つべきなら待機時間を返す。待つべきでなければ undefined。
 *
 * サーバーが待ち時間を示してこない場合は待たない。
 * 当てずっぽうで待つと、いつ終わるか分からない処理になる。
 */
export function rateLimitWaitMs(
  error: unknown,
  state: RateLimitWaitState
): number | undefined {
  if (!(error instanceof AIError)) return undefined;
  if (error.kind !== "rate_limited") return undefined;
  if (error.retryAfterMs === undefined) return undefined;

  // サーバーの指定ちょうどだと際どいので少し余裕を持たせる
  const waitMs = error.retryAfterMs + 1000;
  if (waitMs > MAX_RATE_LIMIT_WAIT_MS) return undefined;
  if (state.totalWaitedMs + waitMs > MAX_TOTAL_RATE_LIMIT_WAIT_MS) {
    return undefined;
  }
  return waitMs;
}

/** 待ちきれずに諦めたときの説明。次に何をすればよいかまで書く */
export function describeRateLimitGiveUp(state: RateLimitWaitState): string {
  return (
    `レート上限のため合計 ${Math.round(state.totalWaitedMs / 1000)} 秒待ちましたが、` +
    "解消しませんでした。無料枠には1日あたりの上限もあり、" +
    "使い切っている場合は待っても回復しません。\n" +
    "時間をおいて再実行するか、呼び出し回数の多い抽出はOllamaで行ってください。" +
    "完了済みのチャンクは次回再利用されます。"
  );
}

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

/**
 * 待つあいだの表示とログの文言を作る（どの機能でも同じ文言にするため1か所に置く）。
 *
 * 待ちは最大90秒続くので、黙っていると止まって見える。
 * VS Code には依存せず、表示とログの出し先は呼ぶ側が渡す。
 */
export function rateLimitWaitHooks(options: {
  sleep: (ms: number) => Promise<boolean>;
  /** 進捗の表示へ出す */
  report: (message: string) => void;
  log: (message: string) => void;
  /** 「3/17」のような進み具合 */
  position: () => string;
}): RateLimitRetryHooks {
  return {
    sleep: options.sleep,
    onWait: (waitMs, state) => {
      const note =
        `レート上限のため ${Math.ceil(waitMs / 1000)} 秒待っています` +
        `（${state.waits}回目 / 合計 ${Math.round(state.totalWaitedMs / 1000)} 秒）`;
      options.report(`${options.position()}  ${note}`);
      options.log(note);
    },
  };
}

/**
 * 待っても通らずに諦めたときの前置き。**待ったことを書かないと、
 * 「しばらく待って」という案内が、待ったあとの作者には的外れに読める**
 */
export function rateLimitGiveUpNote(state: RateLimitRetryState): string {
  if (!state.gaveUp) return "";
  return (
    `レート上限のため合計 ${Math.round(state.waitedSinceSuccessMs / 1000)} 秒待ちましたが、` +
    "解消しませんでした（月や日の上限を使い切っていると、待っても回復しません）。"
  );
}
