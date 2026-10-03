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
    delays?: readonly number[];
    wait?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const delays = hooks.delays ?? LATE_CHECK_DELAYS_MS;
  const wait =
    hooks.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let elapsed = 0;
  for (const at of delays) {
    await wait(Math.max(0, at - elapsed));
    elapsed = at;
    if (intentHolds(memento.get<T>(key, defaultValue), change)) continue;
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
