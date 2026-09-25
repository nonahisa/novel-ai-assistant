/**
 * AI呼び出しの全体キュー（設計書6.76）。
 *
 * それまでは、機能の中（チャンクの連続）は逐次でも**機能の間には何の
 * 制御も無かった**。誤字脱字を回している最中に矛盾検知を押すと、両方が
 * 同時にAIへ投げ始める。Ollamaでは `num_ctx` やモデルの違いで読み込み
 * 直しが往復し（6.27に「2分間に19回の読み込みの末HTTP 500」の実例）、
 * 中止ボタンは後から始めたほうしか止められなかった。
 *
 * ## 2段構えにする理由
 *
 * - **リクエストの関所**（`acquireCall`）：AIへ実際に送るところを、全体で
 *   1件ずつにする。`MeteredProvider` に置くので**機能側の書き忘れが起きない**
 * - **実行の札**（`acquireRun`）：チャンクや話を繰り返す一括機能が、開始から
 *   終了まで丸ごと持つ。関所だけだと A1,B1,A2,B2… と交互に流れてしまい、
 *   読み込み直しの往復が残る
 *
 * ## デッドロックの禁止則
 *
 * **札を持ったまま関所を待つのはよい。関所を持ったまま札を待つ経路は
 * 作らない。** 逆向きを作ると、札を持っている先客が関所待ちで止まり、
 * 関所を持っている側は札が来るまで離さないので、永久に進まない。
 * この一方向（札 → 関所）だけを守れば、待ち合わせの輪ができない。
 *
 * ## VS Code に依存させない
 *
 * 待ち行列の振る舞い（FIFO・中止・解放漏れ）を単体テストで固定したいので、
 * ここは純粋な部品にしてある。進捗の表示や中止ボタンは
 * `features/aiTurn.ts` が受け持つ。
 */

/**
 * 順番待ちの最中に中止された。
 *
 * **`AIError` にしない。** ここは `ai/` を知らない純粋な部品であり、
 * 「AIの失敗」ではなく「並ぶのをやめた」ことしか表していない。
 * `AIError` の `aborted` へ言い換えるのは、受け取った側の仕事である
 * （`MeteredProvider` がそうしている）。
 */
export class AiQueueAbortError extends Error {
  constructor(message = "順番待ちを中止しました。") {
    super(message);
    this.name = "AiQueueAbortError";
  }
}

/** 待っている1件 */
interface Waiter {
  /** 名乗り。実行の札では機能名、関所では使わない */
  readonly label: string;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  /** 中止の見張りを外す。列から抜けるときに必ず呼ぶ */
  readonly detach: () => void;
}

/**
 * 同時に1件だけ通す関所。
 *
 * **取るところは同期で決める。** `acquireX()` を呼んだ順がそのまま
 * 並び順になってほしいので、空いているかの判定と列への追加のあいだに
 * `await` を挟まない。
 */
class SingleLane {
  private holder: string | undefined;
  private readonly waiting: Waiter[] = [];

  /** いま持っている人の名乗り。誰もいなければ undefined */
  currentLabel(): string | undefined {
    return this.holder;
  }

  /** 順番待ちの人数（持っている1件は数えない） */
  pending(): number {
    return this.waiting.length;
  }

  acquire(label: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      // 並ばずに断る。並べてしまうと、抜けるまでのあいだ列が伸びる
      return Promise.reject(new AiQueueAbortError());
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
        reject(new AiQueueAbortError());
      };
      const waiter: Waiter = {
        label,
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  /**
   * 解放関数を作る。
   *
   * **二度呼ばれても無害にする。** `finally` と明示の解放が重なることが
   * あり、そのたびに次が1件ずつ余計に通ると「同時に1件」が崩れる。
   */
  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.handOver();
    };
  }

  private handOver(): void {
    const next = this.waiting.shift();
    if (!next) {
      this.holder = undefined;
      return;
    }
    next.detach();
    this.holder = next.label;
    next.resolve(this.releaser());
  }

  /** 試験用。実際の経路では使わない */
  reset(): void {
    for (const waiter of this.waiting) {
      waiter.detach();
      waiter.reject(new AiQueueAbortError("並びを片付けました。"));
    }
    this.waiting.length = 0;
    this.holder = undefined;
  }
}

/** AIへ実際に送るところ。全機能が必ず通る */
const callLane = new SingleLane();

/** 一括処理のひとまとまり。単発の呼び出しは並ばない */
const runLane = new SingleLane();

/**
 * AIへ送る順番を取る。**戻り値を必ず呼んで返すこと**（`finally` で）。
 *
 * 呼ぶのは `MeteredProvider` だけでよい。機能側から直接呼ぶと、
 * 関所を持ったまま別の待ちに入る経路ができかねない。
 */
export function acquireCall(signal?: AbortSignal): Promise<() => void> {
  return callLane.acquire("ai_call", signal);
}

/** 順番待ちしている送信の件数（試験と診断用） */
export function pendingCallCount(): number {
  return callLane.pending();
}

/**
 * まとまった一括処理の札を取る。**戻り値を必ず呼んで返すこと**。
 *
 * `label` は作者へ見せる機能名（「誤字脱字検知」など）。
 * 待たされている側が「何の完了を待っているのか」を出すのに使う。
 */
export function acquireRun(
  label: string,
  signal?: AbortSignal
): Promise<() => void> {
  return runLane.acquire(label, signal);
}

/** いま札を持っている機能名。待ち表示に使う */
export function currentRunLabel(): string | undefined {
  return runLane.currentLabel();
}

/** 札の順番待ちの件数 */
export function pendingRunCount(): number {
  return runLane.pending();
}

/**
 * 「いま一括処理の中の呼び出しか」を、**非同期の流れに乗せて**運ぶ口（設計書6.76.1）。
 *
 * 手元のAIの門は、別の窓と順番を取るときに「一括処理の1チャンク」と
 * 「相談などの単発」を分けて扱う（単発は別の窓の一括処理の合間に入れる）。
 * `currentRunLabel()` は「このプロセスで一括処理が札を持っているか」しか
 * 分からず、**一括処理の最中に押された相談も一括処理に見えてしまう**。
 * そこで札を取った処理の中だけに印を持たせる。
 *
 * 運ぶ仕組み（Node の `AsyncLocalStorage`）はブラウザ版に無いので、ここは
 * 差し込み口だけにして、中身は門が起動時に入れる（`core/localAiLeaseNode.ts`
 * を動的 import で。CLAUDE.md 規則7）。**差し込まれていなければ、呼ぶ側は
 * 従来の `currentRunLabel()` で見分ける。**
 */
export interface RunScopeCarrier {
  run<T>(label: string, fn: () => T): T;
  current(): string | undefined;
}

let runScopeCarrier: RunScopeCarrier | undefined;

export function setRunScopeCarrier(carrier: RunScopeCarrier | undefined): void {
  runScopeCarrier = carrier;
}

/** 運ぶ仕組みが差し込まれているか */
export function runScopeAvailable(): boolean {
  return runScopeCarrier !== undefined;
}

/**
 * 一括処理の本体を、印を持たせて走らせる（`features/aiTurn.ts` が札を取ったあとに呼ぶ）。
 * 差し込まれていなければ、そのまま走らせる。
 */
export function withinRunScope<T>(label: string, fn: () => T): T {
  return runScopeCarrier ? runScopeCarrier.run(label, fn) : fn();
}

/** いまの呼び出しが属する一括処理の名前。一括処理の外なら undefined */
export function currentRunScope(): string | undefined {
  return runScopeCarrier?.current();
}

/** 試験用。実際の経路では使わない */
export function resetAiSequence(): void {
  callLane.reset();
  runLane.reset();
}
