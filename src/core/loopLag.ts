/**
 * イベントループが**どれだけ握られていたか**を測る（設計書6.107）。
 *
 * ## なぜ要るのか（2026-09-21、ノートPCで測った数字）
 *
 * 0.74.9 の計測は `走査 合計 58,844ms（読み 58,191／数え 331／解析 261）` だった。
 * **数え・解析は合わせて0.6秒**なので、走査の計算そのものは重くない。
 * ところが**同じ機械で Node に直接読ませると 698ファイルで 255ms** である。
 * 読み口は Node 側へ行っているはずなのに、読みだけが58秒かかっている。
 *
 * 残る疑いは2つしかない。
 *
 * 1. **読み口そのものが遅い**（Node の `fs` が、この機械のこの場所では遅い）
 * 2. **`await` が返ったあと再開できずにいる**（起動と同時に走る何かが
 *    イベントループを握っていて、順番が回ってこない）
 *
 * **当てずっぽうで探さない。** 2が本当なら、`setTimeout` を一定の間隔で
 * 繰り返すだけの見張りが、**予定より遅れて呼ばれる**。その遅れの合計が
 * 読みの待ち（`readMs`）と釣り合えば1つ目は消える。
 *
 * ## 読み方
 *
 * - **遅れの合計 ≒ 読みの待ち** → **握られている**。犯人はイベントループを
 *   長く離さない誰か（走査の外にいる）
 * - **遅れの合計 ≪ 読みの待ち** → **読み口が遅い**。待っているあいだ
 *   ループは空いているので、I/O そのものが返っていない
 *
 * **`vscode` に依存させない**（`views`/`features` → `core` → `models` の向き）。
 * 始める場所も止める場所も書き出す場所も `extension.ts` 側にある。
 */

/** 刻みの既定の間隔（ミリ秒）。細かすぎると見張り自身が重くなる */
export const DEFAULT_LOOP_LAG_INTERVAL_MS = 50;

/**
 * 測りつづける上限（ミリ秒）。
 *
 * **止め忘れの保険である。** 見張りは「作品一覧の初回描画」で止めるが、
 * VS Code が一覧を描くのは**サイドバーが見えたとき**なので、作者が
 * 一度も開かない起動では合図が来ない（`core/maintenanceTrigger.ts` と
 * 同じ抜け方）。50ms ごとの目覚ましが一日中鳴り続けるのは、
 * ノートPCでは電池の話になる。
 *
 * 上限は整備の合図待ちと同じ**60秒**にしてある。
 */
export const LOOP_LAG_LIMIT_MS = 60_000;

/** 見張りが持ち帰るもの */
export interface LoopLagReport {
  /** 予定より遅れた分の合計（ミリ秒）。**遅れていなければ0** */
  readonly totalLagMs: number;
  /** 1回の刻みで最も遅れた分（ミリ秒） */
  readonly maxLagMs: number;
  /** 刻んだ回数。遅れの平均を知りたいときに使う */
  readonly ticks: number;
  /** 見張っていた時間（ミリ秒）。上限で自分から止まったかを読むために要る */
  readonly elapsedMs: number;
}

export interface LoopLagMeter {
  /**
   * 見張りを止めて、数字を持ち帰る。
   *
   * **二度呼んでもよい。** 2回目からは1回目と同じものを返す（止めたあとに
   * また数え始めると、止めた時点の数字が読めなくなる）。
   */
  stop(): LoopLagReport;
}

/**
 * イベントループの遅れを測り始める。
 *
 * @param intervalMs 刻みの間隔。**遅れはこの間隔からの超過分**である
 * @param now 現在時刻（ミリ秒）。試験から偽の時計を差すために引数にする。
 *   `Date.now()` を既定にしないのは、**時計合わせで巻き戻る**ことがあるため
 *   （`core/startupTiming.ts` と同じ理由）
 */
export function startLoopLagMeter(
  intervalMs: number = DEFAULT_LOOP_LAG_INTERVAL_MS,
  now: () => number = () => performance.now()
): LoopLagMeter {
  const startedAt = now();
  let totalLagMs = 0;
  let maxLagMs = 0;
  let ticks = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 前の刻みを予約した時刻。**遅れはここからの実測との差**で出す */
  let scheduledAt = startedAt;

  const tick = (): void => {
    if (stopped) return;
    const at = now();
    ticks++;
    /*
      **遅れは「実際にかかった時間 − 頼んだ間隔」**である。負にはしない
      ——`setTimeout` が早く呼ばれることは無いが、偽の時計や丸めで
      わずかに負が出ると、遅れが相殺されて0に見えてしまう。
    */
    const lag = Math.max(0, at - scheduledAt - intervalMs);
    totalLagMs += lag;
    if (lag > maxLagMs) maxLagMs = lag;
    // **上限で自分から止まる**（止め忘れの保険）
    if (at - startedAt >= LOOP_LAG_LIMIT_MS) {
      stopped = true;
      return;
    }
    scheduledAt = at;
    timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, intervalMs);

  return {
    stop(): LoopLagReport {
      if (!stopped) {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      }
      return {
        totalLagMs,
        maxLagMs,
        ticks,
        elapsedMs: now() - startedAt,
      };
    },
  };
}
