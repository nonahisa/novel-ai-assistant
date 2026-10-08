/**
 * いま走っている操作を覚えておき、同じものの2本目を始めさせない
 * （作者の報告 2026-09-12。理由と対象は `exclusiveCommands.ts` にある）。
 *
 * **覚える箱（`Set`）は呼び出し側が持つ。** ここにモジュール変数として
 * 置くと、テストごとに前の状態が残るうえ、拡張機能の再読み込みで
 * 解けないまま残る余地ができる。箱を渡す形なら、生存期間は
 * `activate` のスコープと一致する。
 *
 * VS Code APIに依存しない。
 */

import { exclusiveLabelOf } from "./exclusiveCommands";

/**
 * 走らせてよいかを決め、よければ「走っている」と記録する。
 *
 * **塞ぐ対象でないIDは、いつでも `true`**（覚えもしない）。画面を開くだけの
 * 操作まで覚えると、解き忘れたときに二度と押せなくなる箱が増えるだけである。
 *
 * @returns 始めてよければ `true`。既に走っていれば `false`
 */
export function beginCommand(running: Set<string>, id: string): boolean {
  if (exclusiveLabelOf(id) === undefined) return true;
  if (running.has(id)) return false;
  running.add(id);
  return true;
}

/**
 * 走り終えた（あるいは失敗・中止した）ことを記録する。
 *
 * **呼び出し側は `finally` で必ず通すこと。** 解き忘れると、その操作が
 * 二度と押せなくなる——重複起動より重い壊れ方である。
 */
export function endCommand(running: Set<string>, id: string): void {
  running.delete(id);
}

/**
 * 順番待ちの中止（待っている間に作者が止めた）。
 *
 * `AiQueueAbortError`（`aiSequence.ts`）と分けてあるのは、こちらはAIの送信の
 * 関所ではなく、索引づくりのような「機械で同時に1つ」の仕事の列だからである。
 */
export class TurnWaitAbortedError extends Error {
  constructor(message = "順番待ちを中止しました。") {
    super(message);
    this.name = "TurnWaitAbortedError";
  }
}

interface TurnWaiter {
  readonly label: string;
  readonly resolve: (release: () => void) => void;
  /** 中止の見張りを外す。列から抜けるときに必ず呼ぶ */
  readonly detach: () => void;
}

/**
 * **断らずに、先の仕事が終わるまで待たせる**列（作者の裁定 2026-10-05）。
 *
 * 上の `beginCommand` は「2本目に意味が無い」ものを断る仕組みで、同じコマンドIDの
 * 2回押しにしか効かない。索引づくり（設計書6.87.23）は画面のコマンドからも
 * 外部AI（MCP の run.request）からも来るうえ、**後から来た側にも意味がある**
 * （別の作品・別の依頼）。断ると外部AIの依頼が無駄になるので、順に並ばせる。
 *
 * 振る舞いは 6.76 の実行の札（`aiSequence.ts`）と同じ（同時に1つ・先着順・
 * 待っている間も中止できる）。**列そのものは別に持つ**——同じ列に乗せると、
 * 索引づくりが誤字脱字の10分を待ち、誤字脱字も索引づくりを待つことになる。
 *
 * 箱は呼び出し側が持つ（`beginCommand` と同じ考え方）。VS Code APIに依存しない。
 */
export class TurnQueue {
  private holder: string | undefined;
  private readonly waiting: TurnWaiter[] = [];

  /** いま持っている人の名乗り。誰もいなければ undefined */
  currentLabel(): string | undefined {
    return this.holder;
  }

  /** 順番待ちの人数（持っている1人は数えない） */
  pending(): number {
    return this.waiting.length;
  }

  /**
   * 順番を取る。**戻り値（返す関数）を `finally` で必ず呼ぶこと。**
   * 返し忘れると、それ以降の索引づくりが永久に待たされる。
   *
   * 空いているかの判定と列への追加のあいだに `await` を挟まない
   * （呼んだ順がそのまま並び順になるように）。
   */
  acquire(label: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      // 並ばずに断る。並べてしまうと、抜けるまでのあいだ列が伸びる
      return Promise.reject(new TurnWaitAbortedError());
    }
    if (this.holder === undefined) {
      this.holder = label;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
        waiter.detach();
        reject(new TurnWaitAbortedError());
      };
      const waiter: TurnWaiter = {
        label,
        resolve,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  /** 二度呼ばれても無害にする（`finally` と明示の返却が重なっても2人を通さない） */
  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (!next) {
        this.holder = undefined;
        return;
      }
      next.detach();
      this.holder = next.label;
      next.resolve(this.releaser());
    };
  }
}
