import { isLocalProviderId } from "./localProviders";

/**
 * チャンクを同時に送る数（クラウドのAI）。**唯一の定義**（設計書6.76.3）。
 *
 * Claude で1回の誤字脱字検知が中央224秒かかっていた。待ち時間のほとんどは
 * AIの応答待ちで、クラウドは同時に受け付けられるので、2〜3か所ずつ送れば
 * 縮む（作者の答え「両方入れる」、2026-11-28）。3より増やすと、無料枠の
 * 毎分の上限（さくらは間隔なしで5本目まで通る。`rateLimitRetry.ts`）へ
 * すぐ当たるので3で止める。
 *
 * 輪（`runOrderedQueue`）と関所（`aiSequence.ts` の `acquireCall`）の両方が
 * これを読む。片方だけ増やしても、もう片方で1本に絞られて速くならない。
 */
export const CLOUD_CONCURRENT_CHUNKS = 3;

/**
 * そのプロバイダへ同時に送ってよい数。
 *
 * **手元のAI（Ollama・LM Studio）は1つずつのまま。** 同じGPUを取り合うだけで
 * 速くならず、`num_ctx` の違いで読み込み直しが往復する（設計書6.76）。
 * 判定はプロバイダIDの種類で行い、サービス名を決め打ちしない
 * （知らないIDはクラウド扱い。`isLocalProviderId`）。
 */
export function concurrentChunksFor(providerId: string): number {
  return isLocalProviderId(providerId) ? 1 : CLOUD_CONCURRENT_CHUNKS;
}

export interface OrderedQueueHooks<T, R> {
  /** 同時に走らせる数（1なら従来どおりの順送り） */
  concurrency: number;
  /**
   * 新しく送ってよいか。**中止・致命的な失敗・接続断では false を返す。**
   * 送信中の分はそのまま終わりを待つ（捨てるかどうかは `settle` が決める）
   */
  canStart: () => boolean;
  /**
   * 新しく送る前に待つもの（レート上限の待ちなど）。待つものが無ければ undefined。
   * 待っているあいだは新しく送らない
   */
  holdBeforeStart?: () => Promise<unknown> | undefined;
  /** 並行に走る部分（AIへ送って受け取る）。**例外を投げずに結果で返す** */
  send: (item: T) => Promise<R>;
  /**
   * 結果を受け取る部分。**元の並び（チャンクの順）で1つずつ**呼ぶ。
   * 返した項目は、その項目の直後へ差し込んで、まだ送っていない分として扱う
   * （切り詰められたまとめを話ごとに分け直す道）
   */
  settle: (item: T, result: R) => Promise<T[] | void> | T[] | void;
}

interface Entry<T, R> {
  readonly item: T;
  state: "waiting" | "running" | "done" | "settled";
  result?: R;
}

/**
 * 並びを保ったまま、`concurrency` 本まで同時に送る輪（設計書6.76.3）。
 *
 * ## 並びを変えないための形
 *
 * 送る（`send`）は終わった順に返ってくるが、受け取る（`settle`）は**先頭から
 * 続けて終わった分だけ**を順に呼ぶ。指摘の並び・分け直しの差し込み位置・
 * 書き込みの形が、1つずつ送っていたころと同じになる。
 *
 * ## 1本のときは従来と同じ
 *
 * 1本なら「送る → 受け取る → 次を送る」の順になる。受け取りで分け直した
 * 分は次に送られ、受け取りで止めの旗が立てば次は送られない——手元のAIの
 * 振る舞いを変えないための決まりである。
 *
 * ## 止めたとき
 *
 * `canStart` が false になったら新しく送らない。送信中の分の終わりを待ち、
 * **終わっている分は（途中に終わっていない分があっても）並びの順で受け取る。**
 * 終わっている分の結果を捨てると、中止のたびに払った処理が無駄になる。
 *
 * VS Code に依存しない（並びと同時数を単体テストで固定するため）。
 */
export async function runOrderedQueue<T, R>(
  initial: readonly T[],
  hooks: OrderedQueueHooks<T, R>
): Promise<void> {
  const width = Math.max(1, Math.floor(hooks.concurrency));
  const entries: Entry<T, R>[] = initial.map((item) => ({ item, state: "waiting" }));
  const inflight = new Set<Promise<void>>();
  /** ここより前は受け取り済み */
  let settledUpTo = 0;

  const settleEntry = async (index: number): Promise<void> => {
    const entry = entries[index];
    entry.state = "settled";
    const extra = await hooks.settle(entry.item, entry.result as R);
    if (extra && extra.length > 0) {
      entries.splice(
        index + 1,
        0,
        ...extra.map((item): Entry<T, R> => ({ item, state: "waiting" }))
      );
    }
  };

  /** 先頭から続けて終わった分を、順に受け取る */
  const settlePrefix = async (): Promise<void> => {
    while (settledUpTo < entries.length && entries[settledUpTo].state === "done") {
      await settleEntry(settledUpTo);
      settledUpTo++;
    }
  };

  const start = (entry: Entry<T, R>): void => {
    entry.state = "running";
    const task = hooks.send(entry.item).then(
      (result) => {
        entry.result = result;
        entry.state = "done";
      },
      // `send` は投げない約束だが、投げられても輪を止めないよう結果なしで終える
      () => {
        entry.state = "done";
      }
    );
    const tracked = task.finally(() => inflight.delete(tracked));
    inflight.add(tracked);
  };

  for (;;) {
    await settlePrefix();
    let hold: Promise<unknown> | undefined;
    while (inflight.size < width && hooks.canStart()) {
      hold = hooks.holdBeforeStart?.();
      if (hold) break;
      const next = entries.find((entry) => entry.state === "waiting");
      if (!next) break;
      start(next);
      // **1本のときは、送る前に受け取りを済ませる**（上の「1本のときは従来と
      // 同じ」）。幅の残りがあっても、受け取りが残る分は次の周で埋める
    }
    if (inflight.size === 0) {
      if (hold && hooks.canStart()) {
        await hold;
        continue;
      }
      break;
    }
    await Promise.race(hold ? [...inflight, hold] : [...inflight]);
  }

  // 止めた（または送るものが尽きた）。終わっている分を並びの順で受け取る
  for (let index = 0; index < entries.length; index++) {
    if (entries[index].state === "done") await settleEntry(index);
  }
}
