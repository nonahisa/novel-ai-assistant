/**
 * VS Code の globalState の振る舞いを写した作り物（2026-10-03。0.97.3）。
 *
 * 本物（1.90 と 1.138 の `ExtensionMemento` と `MainThreadStorage`）は次のように動く。
 *
 * - 拡張機能の鍵を**全部まとめて1つの塊**として手元に持つ
 * - `update(鍵, 値)` は塊のその鍵だけを変え、**0ms 後に塊ごと**本体へ送る。
 *   `update` の約束は、送り終えたときに解ける
 * - 本体は塊が変わるたびに、**送ってきた拡張機能ホスト自身にも塊を送り返し**、
 *   手元の塊はそれで**丸ごと差し替わる**
 *
 * **ゆるい作り物（鍵ごとに覚えるだけ）だと、直す前から試験が通ってしまう。**
 * 送り返しの届く時機を外から操れるようにしてある。
 */
export class EchoingMemento {
  /** 拡張機能ホストの手元の塊 */
  private value: Record<string, unknown> = {};
  /** 本体に保存されている塊（次に起動したときに読まれるもの） */
  persisted: Record<string, unknown> = {};
  private waiting: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** まだ届いていない送り返し（古い順） */
  private inTransit: string[] = [];
  /**
   * 立てているあいだ、送った塊の送り返しを**届けずに留める**。
   * 倒したあとの最初の送出の直前に、留めていた古い塊が届く——
   * 「先の書き込みの送り返しが、あとの書き込みと送出のあいだに届く」形
   */
  holdEchoes = false;
  /** 立てると、送るたびに手元も本体も `staleSnapshot` に戻る（何度書いても残らない） */
  sabotage: Record<string, unknown> | undefined;

  get<T>(key: string, defaultValue: T): T {
    const stored = this.value[key];
    return stored === undefined ? defaultValue : (structuredClone(stored) as T);
  }

  update(key: string, value: unknown): Promise<void> {
    this.value[key] = value === undefined ? undefined : structuredClone(value);
    const done = new Promise<void>((resolve) => this.waiting.push(resolve));
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), 0);
    }
    return done;
  }

  /** 留めていた送り返しを、届いた順に当てる（遅れて届く形） */
  deliverHeldEchoes(order: "oldest-first" | "newest-first" = "oldest-first"): void {
    const echoes = this.inTransit.splice(0);
    if (order === "newest-first") echoes.reverse();
    for (const echo of echoes) this.value = JSON.parse(echo) as Record<string, unknown>;
  }

  private flush(): void {
    this.timer = undefined;
    // 留めていない時は、溜まっている古い送り返しが**送出の直前に**届く
    if (!this.holdEchoes) this.deliverHeldEchoes();
    const snapshot = JSON.stringify(this.value);
    this.persisted = JSON.parse(snapshot) as Record<string, unknown>;
    if (this.sabotage) {
      this.persisted = structuredClone(this.sabotage);
      this.value = structuredClone(this.sabotage);
    } else if (this.holdEchoes) {
      this.inTransit.push(snapshot);
    } else {
      // 自分の送り返しは、送り終える前に届く（本物の順）
      this.value = JSON.parse(snapshot) as Record<string, unknown>;
    }
    const waiting = this.waiting.splice(0);
    for (const resolve of waiting) resolve();
  }
}

/** 0ms の送出を先に走らせる */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
