/**
 * 手元のAIの順番を、プロセスをまたいで**2段で**取る（設計書6.76.1 の追記）。
 *
 * ## 何が困っていたか
 *
 * 0.86.13 の札（`localAiLease.ts` の `ProcessLease`）は1枚だけで、一括処理
 * （誤字脱字・推敲・抽出など）のあいだ**ずっと**持たれていた。同じ窓の中なら
 * 相談や単発の生成はチャンクの合間に割り込める（6.76 の決めごと13）のに、
 * **別の窓の相談は、一括処理が終わるまで（10分など）待たされた。**
 * 作者の裁定（2026-09-25 午前）：別の窓でも、同じ窓の中と同じ扱いにする。
 *
 * ## 2段にする
 *
 * 6.76 の「実行の札 → 関所」を、そのまま窓の外へ広げる。
 *
 * - **一括処理のまとまりの札**（`run.json`）：一括処理が始めから終わりまで持つ。
 *   **一括処理どうしは、これで窓をまたいで順番を待つ**（交互に流れて Ollama の
 *   読み込み直しが往復するのを防ぐ——今までと同じ）
 * - **1回の送信の札**（`lease.json`）：実際に送るあいだだけ持つ。一括処理も
 *   **チャンクごとに取って、送り終えたら離す**。単発はこちらだけを取る
 *
 * これだけだと、一括処理が合間に離してすぐ取り直すので、1秒おきに見に来る
 * 別の窓の単発はほとんど間に合わない。そこで、**待っている単発は
 * 「合間に入れてほしい」の印（`interrupt.json`）を出し、一括処理は送信の札を
 * 取り直す前にその印を見て、出ていれば譲る**。単発が送信の札を取ったら印は下がる。
 *
 * ## デッドロックの禁止則（6.76 の延長）
 *
 * 取る順は「まとまりの札 → （印を見て譲る）→ 送信の札 →（呼ぶ側の）関所」の
 * 一方向だけ。**譲って待っているあいだ、一括処理は送信の札も関所も持っていない**
 * ので、印を出した単発を止めるものは無い。単発はまとまりの札を取らないので、
 * 一括処理を待つこともない。
 *
 * ## 古い印・古い札
 *
 * 印も札と同じ形（合言葉・プロセス番号・生存の印＝最終更新時刻）で、
 * **死んだと言い切れるときだけ**片づける（`judgeLease`）。落ちた窓の印を
 * 見て一括処理が永久に譲り続ける、は起きない。
 *
 * ## VS Code にも Node にも依存させない
 *
 * `localAiLease.ts` と同じ。ファイルの操作・時計・プロセスの生死は外から渡す。
 * 試験は `test/unit/core/localAiCrossTurn.test.ts`。
 */

import { AiQueueAbortError } from "./aiSequence";
import {
  LEASE_POLL_MS,
  ProcessLease,
  judgeLease,
  parseLease,
  raceAbort,
  serializeLease,
  type EnterLeaseOptions,
  type LeaseEntry,
  type LeaseEnvironment,
  type LeaseIdentity,
  type LeaseRecord,
} from "./localAiLease";

/** 3つのファイルそれぞれの環境（時計やプロセスの生死は同じものを渡してよい） */
export interface CrossTurnEnvironments {
  /** 1回の送信の札（`lease.json`） */
  readonly send: LeaseEnvironment;
  /** 一括処理のまとまりの札（`run.json`） */
  readonly run: LeaseEnvironment;
  /** 単発の「合間に入れてほしい」の印（`interrupt.json`） */
  readonly interrupt: LeaseEnvironment;
}

export interface CrossTurnOptions {
  /**
   * まとまりの札を、使う者が0になっても持ち続けるか（一括処理のあいだ true）。
   * 拡張機能も MCP も「このプロセスの中の実行の札（6.76）が持たれているか」を渡す
   */
  readonly keepRunWhile?: () => boolean;
  /**
   * このプロセスが、窓をまたぐ札を**どちらも**持たなくなったとき。
   * 管理外の負荷の［このまま送る］を「その実行のあいだ」だけ効かせるのに使う
   */
  readonly onIdle?: () => void;
}

/** 一括処理か、単発か */
export type CrossTurnKind = "run" | "single";

export interface EnterCrossTurnOptions extends EnterLeaseOptions {
  readonly kind: CrossTurnKind;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 単発の「合間に入れてほしい」の印。
 *
 * **プロセスに1枚。** 同じプロセスの中で単発が2つ待っていても印は1つで、
 * 最後の1つが待ち終えたら下げる（数で数える）。
 *
 * 出しているあいだは1秒ごとに見直す：自分の印なら生存の印を打ち、
 * 無くなっていれば（別のプロセスの単発が先に出して、下げた）出し直す。
 * 別のプロセスの印が出ていれば、それで用は足りるので何もしない。
 */
class InterruptMarker {
  private raisedCount = 0;
  private heldText: string | undefined;
  private label = "";
  private timer: { stop(): void } | undefined;
  private busy = false;
  private loggedFailure = false;

  constructor(
    private readonly env: LeaseEnvironment,
    private readonly identity: LeaseIdentity
  ) {}

  raise(label: string): void {
    this.raisedCount += 1;
    if (this.raisedCount > 1) return;
    this.label = label;
    this.timer = this.env.startTimer(() => this.kick(), LEASE_POLL_MS);
    this.kick();
  }

  lower(): void {
    if (this.raisedCount === 0) return;
    this.raisedCount -= 1;
    if (this.raisedCount > 0) return;
    this.timer?.stop();
    this.timer = undefined;
    const text = this.heldText;
    this.heldText = undefined;
    if (text !== undefined) this.remove(text);
  }

  dispose(): void {
    this.raisedCount = 0;
    this.timer?.stop();
    this.timer = undefined;
    const text = this.heldText;
    this.heldText = undefined;
    if (text !== undefined) this.remove(text);
  }

  /**
   * 別のプロセスが出している、生きている印。無ければ undefined。
   * 死んだ印はここで片づける（落ちた窓の印で、一括処理が譲り続けないように）。
   */
  async foreignHolder(): Promise<LeaseRecord | undefined> {
    let current: { text: string; mtimeMs: number } | undefined;
    try {
      current = await this.env.ops.read();
    } catch (error) {
      this.logFailure(`単発の印を読めません（${describe(error)}）`);
      return undefined;
    }
    if (!current) return undefined;
    const parsed = parseLease(current.text);
    const judgement = judgeLease({
      record: parsed,
      heartbeatMs: current.mtimeMs,
      nowMs: this.env.now(),
      selfToken: this.identity.token,
      isAlive: this.env.isAlive,
    });
    if (judgement === "stale") {
      this.env.log?.("持ち主の居ない「合間に入れてほしい」の印を片づけます。");
      try {
        await this.env.ops.removeIfSame(current.text);
      } catch (error) {
        this.logFailure(`古い単発の印を消せません（${describe(error)}）`);
      }
      return undefined;
    }
    // 自分の印では譲らない（同じプロセスの中の順番は 6.76 の関所が決める）。
    // 書きかけで読めない印も譲らない——譲る相手を名乗れないうえ、一瞬で済む
    if (judgement === "mine") return undefined;
    return parsed;
  }

  /** 下げた印の片づけ。MCP は道具を返す前にこれを待つ（`whenSettled`） */
  private pendingRemoval: Promise<void> | undefined;

  async whenSettled(): Promise<void> {
    // 見直しの最中に下げられると、見直しの側が作った印を自分で消す。それも待つ
    await this.ensuring;
    await this.pendingRemoval;
  }

  /** いま走っている見直し（`whenSettled` が待つ） */
  private ensuring: Promise<void> | undefined;

  private kick(): void {
    if (this.busy) return;
    const running = this.ensure();
    this.ensuring = running;
    void running.finally(() => {
      if (this.ensuring === running) this.ensuring = undefined;
    });
  }

  private remove(text: string): void {
    const removal = this.env.ops
      .removeIfSame(text)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logFailure(`単発の印を消せません（${describe(error)}）`);
      });
    this.pendingRemoval = removal;
    void removal.finally(() => {
      if (this.pendingRemoval === removal) this.pendingRemoval = undefined;
    });
  }

  private logFailure(message: string): void {
    // 1秒ごとに見直すので、壊れた機械ではログが埋まる。1回だけ残す
    if (this.loggedFailure) return;
    this.loggedFailure = true;
    this.env.log?.(message);
  }

  private async ensure(): Promise<void> {
    if (this.busy || this.raisedCount === 0) return;
    this.busy = true;
    try {
      if (this.heldText !== undefined) {
        const current = await this.env.ops.read();
        if (current?.text === this.heldText) {
          await this.env.ops.touch();
          return;
        }
        // 消えていた（片づけられた）。出し直す
        this.heldText = undefined;
      }
      const record: LeaseRecord = {
        version: 1,
        token: this.identity.token,
        pid: this.identity.pid,
        host: this.identity.host,
        label: this.label,
        ...(this.identity.windowName ? { windowName: this.identity.windowName } : {}),
        startedAt: new Date(this.env.now()).toISOString(),
      };
      const text = serializeLease(record);
      if (await this.env.ops.tryCreate(text)) {
        // 作っているあいだに待ち終えていた。**残さない**（残すと一括処理が譲り続ける）
        if (this.raisedCount === 0) {
          await this.env.ops.removeIfSame(text);
          return;
        }
        this.heldText = text;
        return;
      }
      const current = await this.env.ops.read();
      if (!current) return;
      const judgement = judgeLease({
        record: parseLease(current.text),
        heartbeatMs: current.mtimeMs,
        nowMs: this.env.now(),
        selfToken: this.identity.token,
        isAlive: this.env.isAlive,
      });
      if (judgement === "stale") await this.env.ops.removeIfSame(current.text);
      else if (judgement === "mine") this.heldText = current.text;
      // "held"：別のプロセスの単発が出している。それで用は足りる
    } catch (error) {
      // **印が出せなくても、単発は今までどおり待つ**（合間に入れないだけ）
      this.logFailure(`単発の印を出せません（${describe(error)}）`);
    } finally {
      this.busy = false;
    }
  }
}

/**
 * 窓をまたぐ2段の順番。プロセスに1つ作る（拡張機能は門が、MCP は
 * `mcp/localAiTurn.ts` が持つ）。
 */
export class CrossProcessTurn {
  private readonly runLease: ProcessLease;
  private readonly sendLease: ProcessLease;
  private readonly marker: InterruptMarker;

  constructor(
    private readonly envs: CrossTurnEnvironments,
    identity: LeaseIdentity,
    options: CrossTurnOptions = {}
  ) {
    const onIdle = options.onIdle;
    this.runLease = new ProcessLease(envs.run, identity, {
      ...(options.keepRunWhile ? { keepWhile: options.keepRunWhile } : {}),
      onDropped: () => {
        if (!this.sendLease.isHeld()) onIdle?.();
      },
    });
    this.sendLease = new ProcessLease(envs.send, identity, {
      onDropped: () => {
        if (!this.runLease.isHeld()) onIdle?.();
      },
    });
    this.marker = new InterruptMarker(envs.interrupt, identity);
  }

  /** このプロセスが一括処理のまとまりの札を持っているか（試験と診断用） */
  holdsRun(): boolean {
    return this.runLease.isHeld();
  }

  /** このプロセスが送信の札を持っているか（試験と診断用） */
  holdsSend(): boolean {
    return this.sendLease.isHeld();
  }

  /**
   * 送ってよくなるまで待つ。**1回の送信ごとに呼び、送り終えたら `release`**。
   *
   * - `kind: "run"`（一括処理の中の1回）：まとまりの札 → 単発へ譲る → 送信の札。
   *   まとまりの札は `keepRunWhile` が true のあいだ、送り終えても持ち続ける
   * - `kind: "single"`（相談・単発の生成）：送信の札だけ。待つあいだは
   *   「合間に入れてほしい」の印を出す
   *
   * 戻り値の `fresh` は**管理外の負荷を見るべき時か**：一括処理はまとまりの札を
   * 新しく取ったとき、単発はこのプロセスが一括処理の外で送信の札を新しく取ったとき。
   * **チャンクごとには true にしない**（nvidia-smi を毎チャンク呼ばない。6.76.2）。
   *
   * 中止は `AiQueueAbortError`。札が扱えなければ `unavailable`（呼ぶ側は送る）。
   */
  async enter(label: string, options: EnterCrossTurnOptions): Promise<LeaseEntry> {
    const { kind, signal, onWait } = options;
    if (signal?.aborted) throw new AiQueueAbortError();
    if (kind === "single") return await this.enterSingle(label, signal, onWait);

    const run = await this.runLease.enter(label, {
      ...(signal ? { signal } : {}),
      ...(onWait ? { onWait } : {}),
    });
    if (run.kind === "unavailable") return run;

    let yielded: { waitedMs: number; holder?: LeaseRecord };
    let send: LeaseEntry;
    try {
      yielded = await this.yieldToSingles(signal, onWait);
      send = await this.sendLease.enter(label, {
        ...(signal ? { signal } : {}),
        ...(onWait ? { onWait } : {}),
      });
    } catch (error) {
      run.release();
      throw error;
    }
    if (send.kind === "unavailable") {
      run.release();
      return send;
    }

    // 作者へ出すのは「いちばん待たされた理由」。一括処理を待ったならそれ、
    // 次に譲った単発、最後に送信の札の相手
    const waitedFor = run.waitedFor ?? yielded.holder ?? send.waitedFor;
    let released = false;
    return {
      kind: "held",
      release: () => {
        if (released) return;
        released = true;
        send.release();
        run.release();
      },
      fresh: run.fresh,
      waitedMs: run.waitedMs + yielded.waitedMs + send.waitedMs,
      ...(waitedFor ? { waitedFor } : {}),
    };
  }

  /** 一括処理（このプロセスの中の実行の札）が終わったとき。まとまりの札を離す機会 */
  runEnded(): void {
    this.runLease.releaseIfIdle();
  }

  /** 離した札・印の片づけが済むまで待つ（MCP の道具が返る前） */
  async whenSettled(): Promise<void> {
    await Promise.all([
      this.sendLease.whenSettled(),
      this.runLease.whenSettled(),
      this.marker.whenSettled(),
    ]);
  }

  /** 終わるとき（拡張機能の `deactivate`・MCP の終了・試験の片づけ） */
  async dispose(): Promise<void> {
    this.marker.dispose();
    await Promise.all([this.sendLease.dispose(), this.runLease.dispose()]);
  }

  private async enterSingle(
    label: string,
    signal: AbortSignal | undefined,
    onWait: ((holder: LeaseRecord) => void) | undefined
  ): Promise<LeaseEntry> {
    let raised = false;
    try {
      const send = await this.sendLease.enter(label, {
        ...(signal ? { signal } : {}),
        onWait: (holder) => {
          // **待たされたときだけ**印を出す（空いていれば一瞬で取れるので、
          // 印を出し入れするだけ無駄になる）
          if (!raised) {
            raised = true;
            this.marker.raise(label);
          }
          onWait?.(holder);
        },
      });
      if (send.kind === "unavailable") return send;
      return { ...send, fresh: send.fresh && !this.runLease.isHeld() };
    } finally {
      if (raised) this.marker.lower();
    }
  }

  /**
   * 別のプロセスの単発が「合間に入れてほしい」を出していれば、下がるまで待つ。
   *
   * **このあいだ送信の札も関所も持っていない**ので、印を出した単発は必ず
   * 進める（デッドロックの禁止則）。印の持ち主が落ちれば、`foreignHolder` が
   * 古い印として片づけるので、永久には待たない。
   */
  private async yieldToSingles(
    signal: AbortSignal | undefined,
    onWait: ((holder: LeaseRecord) => void) | undefined
  ): Promise<{ waitedMs: number; holder?: LeaseRecord }> {
    const env = this.envs.interrupt;
    const started = env.now();
    let seen: LeaseRecord | undefined;
    for (;;) {
      if (signal?.aborted) throw new AiQueueAbortError();
      const holder = await this.marker.foreignHolder();
      if (!holder) {
        return { waitedMs: seen ? env.now() - started : 0, ...(seen ? { holder: seen } : {}) };
      }
      if (holder.token !== seen?.token) {
        seen = holder;
        env.log?.(
          `別のプロセスの単発（${holder.label}、プロセス ${holder.pid}）へ、チャンクの合間を譲ります。`
        );
        onWait?.(holder);
      }
      await raceAbort(env.sleep(LEASE_POLL_MS), signal);
    }
  }
}
