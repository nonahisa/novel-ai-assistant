/**
 * globalState へ書いたあと、**読み返して確かめる**書き込み（2026-10-03。0.97.3）。
 *
 * ## なぜ要るか
 *
 * VS Code の globalState（拡張機能ごとの保管庫）は、拡張機能の鍵を**全部まとめて
 * 1つの塊**として持っている。`update(鍵, 値)` は塊のその鍵だけを変え、少しあとで
 * **塊ごと**本体へ送る。本体は塊が変わるたびに、**送ってきた拡張機能ホスト自身にも**
 * 塊を送り返し、拡張機能ホストはそれで手元の塊を**丸ごと差し替える**。
 *
 * そのため、**先に書いた別の鍵の塊（たとえば起動のときの「はじめまして」の印）の
 * 送り返しが、あとから書いた鍵（登録簿）より遅れて届く**と、手元の塊から
 * あとの鍵が消え、そのまま本体へ送られて保存される。`update()` は成功で終わるので、
 * 呼んだ側は気づかない——画面の自動テストで「登録しました」と出たのに登録簿から
 * 消える形で見つかった（4回に1回ほど）。詳しい測定は設計書の登録簿の節（5.7.8）。
 *
 * ## 何をするか
 *
 * 1. 書いたら読み返し、**変えたいことが入っていなければ、いまの値を読み直して
 *    当て直して**書き直す（`updateVerified`）。当て直すのは、別の窓が同じ鍵に
 *    足したものを踏みつぶさないため。実測ではほとんどが1回の書き直しで落ち着く
 * 2. まれに、読み返しのときは入っていたのに、**そのあと遅れて届いた古い塊で
 *    消える**ことがある（1.138 で約3,600回中5回）。そこで書いたあとしばらく、
 *    何度か見に行って、消えていれば当て直す（`watchForLateLoss`）
 *
 * 何度書き直しても入らなければ**投げる**。黙って消えるより、
 * 「登録できませんでした」と出るほうが作者は困らない（やり直せる）。
 *
 * `vscode` には依存しない（`Memento` の形だけを使う）。試験から作り物を渡せる。
 */

/** 使うのは読みと書きだけ（`vscode.Memento` の一部） */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** 書き直す回数の上限。実測ではほとんどが1回の書き直しで落ち着く */
export const MAX_VERIFIED_WRITES = 5;

/**
 * 書いたあと見に行く時機（ミリ秒、書き終えてからの経過）。
 * 実測では、遅れて消える形も50ms以内に起きていた。余裕を見て2秒まで見る
 */
export const LATE_CHECK_DELAYS_MS: readonly number[] = [100, 500, 2000];

/** 何度書いても読み返しが合わなかった */
export class MementoWriteLostError extends Error {
  constructor(readonly key: string, readonly attempts: number) {
    super(
      `設定の保管場所（globalState の ${key}）へ書いた内容が、${attempts}回書き直しても残りませんでした。` +
        `VS Code のほかの保存と重なった可能性があります。もう一度お試しください。`
    );
    this.name = "MementoWriteLostError";
  }
}

/**
 * いまの値に、変えたいことがもう入っているか。
 *
 * **`change` は「何度当てても同じ」形で書く**（足すなら「無ければ足す」、
 * 外すなら「あれば外す」）。だから「当てても変わらない」なら、入っている。
 * 書いた値と丸ごと比べないのは、別の窓が同じ鍵に足したものまで
 * 「違う」と見て書き直さないため。
 */
function intentHolds<T>(current: T, change: (current: T) => T): boolean {
  return sameJson(change(current), current);
}

/**
 * `key` の値を `change` で変えて書き、読み返して確かめる。
 *
 * @param change いまの値から次の値を作る。**書き直しのたびに、その時点の値で
 *   呼び直す**ので、副作用を持たせず、何度当てても同じ結果になる形にする
 * @returns 最後に書いて確かめた値
 */
export async function updateVerified<T>(
  memento: MementoLike,
  key: string,
  defaultValue: T,
  change: (current: T) => T
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_VERIFIED_WRITES; attempt++) {
    const next = change(memento.get<T>(key, defaultValue));
    await memento.update(key, next);
    const after = memento.get<T>(key, defaultValue);
    if (intentHolds(after, change)) return after;
  }
  throw new MementoWriteLostError(key, MAX_VERIFIED_WRITES);
}

/**
 * 書いたあとしばらく見張り、遅れて消えていたら当て直す。
 *
 * **待たない**（呼び手は `void` で投げる）。登録の終わりをこの見張りで
 * 遅らせない。
 *
 * `change` は**見に行くたびに呼び直す**ので、呼び手はその時点で守りたいこと
 * （その後に足した変更も含めて）を返す関数を渡せる（`WorkRegistry` がそうしている）。
 *
 * @param onRepaired 当て直したときに呼ぶ（一覧を描き直す・ログに残す）
 * @param onFailed 当て直せなかったときに呼ぶ
 * @param wait 待ち方。試験から差し替える
 */
export async function watchForLateLoss<T>(
  memento: MementoLike,
  key: string,
  defaultValue: T,
  change: (current: T) => T,
  hooks: {
    onRepaired?: () => void;
    onFailed?: (error: unknown) => void;
    /**
     * 消えていたとき、当て直してよいか。false なら当て直さずに見張りをやめる
     * （`onSkipped` を呼ぶ）。**別の窓が同じ鍵を書き換えたのを、こちらの古い
     * 値で踏みつぶさない**ために使う（`VerifiedState` の「値を置く」書き込み）
     */
    shouldRepair?: (current: T) => boolean;
    onSkipped?: () => void;
    delays?: readonly number[];
    wait?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const delays = hooks.delays ?? LATE_CHECK_DELAYS_MS;
  const wait = hooks.wait ?? defaultWait;
  let elapsed = 0;
  for (const at of delays) {
    await wait(Math.max(0, at - elapsed));
    elapsed = at;
    const current = memento.get<T>(key, defaultValue);
    if (intentHolds(current, change)) continue;
    if (hooks.shouldRepair && !hooks.shouldRepair(current)) {
      hooks.onSkipped?.();
      return;
    }
    try {
      await updateVerified(memento, key, defaultValue, change);
      hooks.onRepaired?.();
    } catch (error) {
      hooks.onFailed?.(error);
      return;
    }
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 見張りの既定の待ち方。**待ちのせいで VS Code（や試験）の終わりを
 * 引き止めない**よう、Node では `unref` する（ブラウザでは数値が返るので何もしない）
 */
function defaultWait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer: unknown = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/* ------------------------------------------------------------------ */
/* 守った保管庫（0.97.4）                                               */
/* ------------------------------------------------------------------ */

/**
 * 包む元の保管庫。`vscode.Memento` も試験の作り物もそのまま渡せるよう、
 * 形をゆるく受ける（`get` が既定値を見ない作り物もあるので、読むときに補う）
 */
export interface InnerMemento {
  get(key: string, defaultValue?: unknown): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
  keys?(): readonly string[];
}

/** 当て直した・当て直せなかった・見送ったを、拡張機能のログへ流す口 */
export interface VerifiedStateReporter {
  onRepaired?(key: string): void;
  onFailed?(key: string, error: unknown): void;
  /** 消えていたが、別の所で値が変わっていたので当て直さなかった */
  onSkipped?(key: string): void;
}

let reporter: VerifiedStateReporter = {};

/**
 * ログへの口をつなぐ（拡張機能の起動時に1回）。`core` のこのファイルは
 * `vscode` にもログにも依存させないので、外から差し込む。
 */
export function setVerifiedStateReporter(next: VerifiedStateReporter): void {
  reporter = next;
}

export interface VerifiedStateOptions {
  /** 書いたあと見に行く時機。試験では `[]` にして見張りを止める */
  lateCheckDelays?: readonly number[];
  wait?: (ms: number) => Promise<void>;
}

/** 見張りの期間にある書き込み1つ */
interface RecentChange {
  change: (current: unknown) => unknown;
  /** 「値を置く」書き込みか（`update`）、「足す・外す」書き込みか（`patch`） */
  kind: "set" | "patch";
  /** 書く直前の値。値を置く書き込みで、別の窓の変更と見分けるのに使う */
  before: unknown;
  until: number;
}

/**
 * globalState（と workspaceState）の**書き込みを必ず確かめる**包み（設計書5.7.8）。
 *
 * `vscode.Memento` と同じ形（`get`／`keys`／`update`）を持つので、
 * 保管庫を受け取る部品（`AdvicePolicyStore` など）へそのまま渡せる。
 *
 * - `update(鍵, 値)`：**値を置く**。書いたら読み返し、入っていなければ置き直す
 *   （`updateVerified`）。そのあと少しのあいだ見張り（`watchForLateLoss`）、
 *   遅れて消えていたら置き直す。ただし**書く前の値に戻っているときだけ**——
 *   別の窓が違う値を置いたのなら、それは作者の新しい選択なので踏みつぶさない
 * - `patch(鍵, 既定値, 変え方)`：**足す・外す**。変え方は何度当てても同じ形で
 *   書く（`updateVerified` の約束）。別の窓が足した分は残るので、見張りは
 *   書く前の値を問わず当て直す
 *
 * **見張りは、自分の書き込みだけでなく、期間にある同じ鍵の書き込みすべてを
 * した順に当てる。** 自分の閉包だけを当てると、作者が2秒以内に選び直した値を
 * 前の見張りが元へ戻してしまう（A→B と選んだのに A に戻る）。
 *
 * 何度書いても残らなければ `MementoWriteLostError` を投げる。
 */
export class VerifiedState {
  private readonly recent = new Map<string, RecentChange[]>();

  constructor(
    private readonly inner: InnerMemento,
    private readonly options: VerifiedStateOptions = {}
  ) {}

  /** 既定値を補って読む（`get` が既定値を見ない作り物にも合わせる） */
  private readonly io: MementoLike = {
    get: <T>(key: string, defaultValue: T): T => {
      const value = this.inner.get(key, defaultValue);
      return (value === undefined ? defaultValue : value) as T;
    },
    update: (key: string, value: unknown) => this.inner.update(key, value),
  };

  keys(): readonly string[] {
    return this.inner.keys?.() ?? [];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.io.get<T | undefined>(key, defaultValue);
  }

  /** 値を置く（消すなら `undefined`）。確かめてから返る */
  async update(key: string, value: unknown): Promise<void> {
    const copy = value === undefined ? undefined : cloneJson(value);
    await this.write(key, undefined, () => copy, "set");
  }

  /**
   * いまの値に変更を当てる。**変え方は何度当てても同じ結果になる形で書く**
   * （無ければ足す・あれば外す）。書き直しのたびに、その時点の値で呼び直す
   *
   * @returns 書いて確かめた値
   */
  async patch<T>(
    key: string,
    defaultValue: T,
    change: (current: T) => T
  ): Promise<T> {
    return (await this.write(
      key,
      defaultValue,
      change as (current: unknown) => unknown,
      "patch"
    )) as T;
  }

  private async write(
    key: string,
    defaultValue: unknown,
    change: (current: unknown) => unknown,
    kind: RecentChange["kind"]
  ): Promise<unknown> {
    const delays = this.options.lateCheckDelays ?? LATE_CHECK_DELAYS_MS;
    const now = Date.now();
    const before = this.io.get<unknown>(key, defaultValue);
    const span = delays.length > 0 ? Math.max(...delays) + 1000 : 0;
    const list = (this.recent.get(key) ?? []).filter((r) => r.until > now);
    const record: RecentChange = { change, kind, before, until: now + span };
    list.push(record);
    this.recent.set(key, list);

    let written: unknown;
    try {
      written = await updateVerified<unknown>(this.io, key, defaultValue, change);
    } catch (error) {
      /*
        **失敗と伝えた書き込みを、あとから黙って入れない。** 記録を残すと、
        同じ鍵の次の書き込みの見張りがこれも当て直してしまう
      */
      const rest = (this.recent.get(key) ?? []).filter((r) => r !== record);
      if (rest.length === 0) this.recent.delete(key);
      else this.recent.set(key, rest);
      throw error;
    }
    if (delays.length === 0) return written;

    /* 待たない。見張りは書き込みの終わりを遅らせない */
    void watchForLateLoss<unknown>(
      this.io,
      key,
      defaultValue,
      (current) => this.applyRecent(key, current),
      {
        delays,
        wait: this.options.wait,
        shouldRepair: (current) => this.mayRepair(key, current),
        onRepaired: () => reporter.onRepaired?.(key),
        onFailed: (error) => reporter.onFailed?.(key, error),
        onSkipped: () => reporter.onSkipped?.(key),
      }
    );
    return written;
  }

  /** 期間にある同じ鍵の書き込みを、した順に当てる */
  private applyRecent(key: string, current: unknown): unknown {
    const now = Date.now();
    const list = (this.recent.get(key) ?? []).filter((r) => r.until > now);
    if (list.length === 0) this.recent.delete(key);
    else this.recent.set(key, list);
    return list.reduce((value, r) => r.change(value), current);
  }

  /**
   * 当て直してよいか。足す・外すだけなら、別の窓の分を残したまま当てられる。
   * **値を置く書き込みが混ざっていれば、いまの値が「こちらが書く前の値」の
   * どれかに戻っているときだけ**（送り返しで巻き戻った形）。それ以外の値は
   * 別の窓で作者が選んだものなので、こちらの値で上書きしない
   */
  private mayRepair(key: string, current: unknown): boolean {
    const list = this.recent.get(key) ?? [];
    if (list.every((r) => r.kind === "patch")) return true;
    return list.some((r) => sameJson(r.before, current));
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 元の保管庫ごとに1つ。**同じ鍵の書き込みを同じ包みに集める**ため */
const instances = new WeakMap<object, VerifiedState>();

/**
 * 保管庫を守った包みにして返す（同じ保管庫には同じ包み）。
 *
 * **globalState・workspaceState へ書くときは、必ずこれを通す**
 * （`test/unit/cross/mementoWrites.test.ts` が見張る）。
 * `options` が効くのは最初に包んだときだけ（試験が先に包んで見張りを止める）。
 */
export function verifiedState(
  inner: InnerMemento | VerifiedState,
  options?: VerifiedStateOptions
): VerifiedState {
  if (inner instanceof VerifiedState) return inner;
  const known = instances.get(inner);
  if (known) return known;
  const created = new VerifiedState(inner, options);
  instances.set(inner, created);
  return created;
}
