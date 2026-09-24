/**
 * 手元のAI（Ollama・LM Studio）へ送る順番を、**プロセスをまたいで**取る札（設計書6.76.1）。
 *
 * ## 何が足りなかったか
 *
 * 6.76 の関所（`aiSequence.ts`）は、**同じ拡張機能ホストの中**だけを並べる。
 * ところが手元のAIへ送る者は、1つの機械にいくつも居る——別の VS Code の窓、
 * 開発ホスト、MCP サーバー（Claude Code から `novel.run` で手元のAIを回す）。
 * それぞれ自分の列しか知らないので、2つが同時に Ollama を叩く
 * （2026-09-25 夜、測定の担当が2つ同時に叩いた）。
 *
 * ## どう並べるか
 *
 * 保管庫（`globalStorage`）に**札のファイルを1つ**置く。中身は「いま手元のAIへ
 * 送っている者」——プロセス番号・どちら側か（窓か MCP か）・窓の名前・機能名・
 * 始めた時刻。**生存の印（heartbeat）はファイルの最終更新時刻**で持つ
 * （中身を書き直さずに時刻だけ打ち直すので、読む側が書きかけを見ない）。
 *
 * - **取るときは原子的に作る**（無ければ作る・あれば失敗。`LeaseFileOps.tryCreate`）
 * - **死んだ札は奪ってよい**：プロセスが居ない、または生存の印が古い
 * - **取れなければ一定の間隔で見に行く**（ファイルの見張りは OS によって
 *   取りこぼすので、確実なほうを選ぶ）
 *
 * ## プロセスの中では共有する
 *
 * 札は**プロセスに1枚**である。同じプロセスの中の順番は 6.76 の関所と実行の札が
 * 決めるので、ここでは数を数えるだけにする（`users`）。持っている間に同じ
 * プロセスから来た者は、待たずに通す。
 *
 * ## 失敗しても本来の処理を止めない
 *
 * 札のファイルが読めない・書けないときは「札なし」（`unavailable`）を返し、
 * 呼ぶ側は**今までどおり送る**（理由はログへ）。順番待ちは「あればよいもの」で、
 * これが壊れて執筆の道具そのものが止まるほうが害が大きい。
 *
 * ## VS Code にも Node にも依存させない
 *
 * ファイルの操作・時計・プロセスの生死は外から渡す。札の取り合い・古い札の
 * 判定・中止を単体テストで固定するため（`test/unit/core/localAiLease.test.ts`）。
 * Node で動かす部品は `localAiLeaseNode.ts` にある。
 */

import { AiQueueAbortError } from "./aiSequence";

/** 保管庫の中の置き場（`globalStorage/<拡張機能ID>/local-ai/lease.json`） */
export const LOCAL_AI_LEASE_DIRECTORY = "local-ai";
export const LOCAL_AI_LEASE_FILE = "lease.json";

/**
 * 生存の印を打ち直す間隔（ミリ秒）。
 *
 * **下の「古い」とみなす長さの数分の1にしておく。** 機械が一瞬重くて1回
 * 打ち損ねても、奪われないようにするため。
 */
export const LEASE_HEARTBEAT_MS = 10_000;

/**
 * 生存の印がこれより古ければ、持ち主は居ないとみなす（ミリ秒）。
 *
 * プロセスが落ちたのにファイルだけ残った札を、いつまでも待たないための線。
 * **プロセスの生死が分かるときはそちらが先に効く**（すぐ奪える）ので、
 * これは「分からないとき」と「番号が別のプロセスに使い回されたとき」の保険である。
 */
export const LEASE_STALE_MS = 60_000;

/** 取れなかったときに見に行き直す間隔（ミリ秒） */
export const LEASE_POLL_MS = 1_000;

/**
 * 中身が読めない札を「書きかけ」とみなして待つ長さ（ミリ秒）。
 *
 * 作ってから中身を書き終えるまでの一瞬に読むと、空や途中の中身が見える
 * （`tryCreate` は中身ごと置く作りにしてあるが、置けない機械では2段になる）。
 * それを過ぎても読めない札は、壊れたものとして片づける。
 */
export const LEASE_UNREADABLE_GRACE_MS = 5_000;

/** 札を持っているのは、どちら側か */
export type LeaseHost = "extension" | "mcp";

/** 札の中身 */
export interface LeaseRecord {
  readonly version: 1;
  /** この札を取った者だけが知る合言葉。**プロセス番号は使い回される**ので、これで見分ける */
  readonly token: string;
  readonly pid: number;
  readonly host: LeaseHost;
  /** 作者へ見せる機能名（「誤字脱字の検知」など） */
  readonly label: string;
  /** 窓の名前（拡張機能の側だけ。フォルダーを開いていない窓は無い） */
  readonly windowName?: string;
  /** 取った時刻（ISO 8601） */
  readonly startedAt: string;
}

export function serializeLease(record: LeaseRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * 札を読む。**読めなければ undefined**（直さない。書きかけか壊れたものとして扱う）。
 */
export function parseLease(text: string): LeaseRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (typeof record.token !== "string" || record.token.length === 0) {
    return undefined;
  }
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) {
    return undefined;
  }
  if (record.host !== "extension" && record.host !== "mcp") return undefined;
  if (typeof record.label !== "string") return undefined;
  if (typeof record.startedAt !== "string") return undefined;
  return {
    version: 1,
    token: record.token,
    pid: record.pid,
    host: record.host,
    label: record.label,
    ...(typeof record.windowName === "string" && record.windowName.length > 0
      ? { windowName: record.windowName }
      : {}),
    startedAt: record.startedAt,
  };
}

/** 札の見立て */
export type LeaseJudgement = "mine" | "held" | "stale";

export interface JudgeLeaseInput {
  /** 読めた中身。読めなければ undefined */
  readonly record: LeaseRecord | undefined;
  /** ファイルの最終更新時刻＝最後の生存の印（ミリ秒） */
  readonly heartbeatMs: number;
  readonly nowMs: number;
  /** 自分の合言葉 */
  readonly selfToken: string;
  /**
   * そのプロセスが生きているか。**分からなければ undefined**
   * （権限が無い・調べられない。生存の印だけで決める）。
   */
  readonly isAlive: (pid: number) => boolean | undefined;
}

/**
 * 札が誰のものか、まだ生きているかを見立てる。
 *
 * **死んだと言い切れるときだけ奪う。** 生きている持ち主から奪うと、
 * 2つが同時に送ることになる——この仕組みで防ぎたいことそのものである。
 */
export function judgeLease(input: JudgeLeaseInput): LeaseJudgement {
  const age = input.nowMs - input.heartbeatMs;
  if (!input.record) {
    return age < LEASE_UNREADABLE_GRACE_MS ? "held" : "stale";
  }
  if (input.record.token === input.selfToken) return "mine";
  if (age >= LEASE_STALE_MS) return "stale";
  if (input.isAlive(input.record.pid) === false) return "stale";
  return "held";
}

/**
 * 待たせている相手の言い方。**作者が「どれを待っているのか」を探せる**ように、
 * 窓なら窓の名前、MCP なら外部AIからだと添える。
 */
export function holderPhrase(record: LeaseRecord): string {
  if (record.host === "mcp") return `外部AI（MCP）の「${record.label}」`;
  const where = record.windowName ? `別の窓（${record.windowName}）` : "別の窓";
  return `${where}の「${record.label}」`;
}

/** 待っているあいだの文言（6.76 の「「〜」の完了を待っています…」と揃える） */
export function leaseWaitingMessage(record: LeaseRecord): string {
  return `${holderPhrase(record)}の完了を待っています…`;
}

/**
 * 札のファイルの操作。**中身の書き換えは無い**（作る・読む・消す・時刻を打つ）。
 */
export interface LeaseFileOps {
  /**
   * 無ければ作って true。**既にあれば false**（上書きしない）。
   * 作れたときは、**中身ごと見えること**（書きかけを読ませない）が望ましい。
   */
  tryCreate(text: string): Promise<boolean>;
  /** 中身と最終更新時刻。無ければ undefined */
  read(): Promise<{ text: string; mtimeMs: number } | undefined>;
  /**
   * 中身がまだ `text` のときだけ消す。消した（か、もう無かった）なら true。
   * **他人が取り直した札を消さない**ための確かめである。
   */
  removeIfSame(text: string): Promise<boolean>;
  /** 生存の印を打つ（最終更新時刻を今へ） */
  touch(): Promise<void>;
}

/** 札が外から受け取るもの */
export interface LeaseEnvironment {
  readonly ops: LeaseFileOps;
  readonly now: () => number;
  readonly isAlive: (pid: number) => boolean | undefined;
  /** 待つ。中止の合図は持たない（待っている者が抜けたかは札の側で数える） */
  readonly sleep: (ms: number) => Promise<void>;
  /** 繰り返しの時計。止める口を返す */
  readonly startTimer: (tick: () => void, ms: number) => { stop(): void };
  /** ログ。**作者の画面には出さない**（出すかどうかは呼ぶ側が決める） */
  readonly log?: (message: string) => void;
}

export interface LeaseIdentity {
  readonly pid: number;
  readonly host: LeaseHost;
  readonly token: string;
  readonly windowName?: string;
}

/** 札へ入った結果 */
export type LeaseEntry =
  | {
      readonly kind: "held";
      /** 抜ける。**必ず呼ぶ**（二度呼んでも害は無い） */
      readonly release: () => void;
      /**
       * このプロセスが**いま新しく**札を取ったか。管理外の負荷を見るのは
       * このとき（と一定の間隔ごと）だけにする
       */
      readonly fresh: boolean;
      /** 待った長さ（ミリ秒）。待たなければ 0 */
      readonly waitedMs: number;
      /** 待たせた相手（最後に見た持ち主）。待たなければ undefined */
      readonly waitedFor?: LeaseRecord;
    }
  | {
      /** 札を扱えなかった。**呼ぶ側は今までどおり送る** */
      readonly kind: "unavailable";
      readonly release: () => void;
      readonly reason: string;
    };

export interface EnterLeaseOptions {
  readonly signal?: AbortSignal;
  /** 待ちに入ったとき・待たせている相手が替わったときに呼ぶ */
  readonly onWait?: (holder: LeaseRecord) => void;
}

export interface ProcessLeaseOptions {
  /**
   * 使う者が0になっても、札を持ち続けるか。
   *
   * 拡張機能の側は**一括処理の札（6.76）を持っている間は離さない**。
   * チャンクの合間ごとに離すと、別の窓と A1,B1,A2,B2… と交互に流れ、
   * Ollama の読み込み直しが往復する（6.76 で実行の札を足したのと同じ理由）。
   */
  readonly keepWhile?: () => boolean;
  /** 札を離したとき（管理外の負荷の「しばらく出さない」を解くのに使う） */
  readonly onDropped?: () => void;
}

type LoopOutcome =
  | { kind: "acquired"; waitedMs: number; waitedFor?: LeaseRecord }
  | { kind: "unavailable"; reason: string }
  | { kind: "abandoned" };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noop(): void {
  // 何もしない（札を扱えなかったときの抜け口）
}

/**
 * プロセスに1枚の札。
 *
 * **取り合いの抜け穴（残した観測）**：古い札を片づけるのは「中身を読んで、
 * 同じなら消す」の2段なので、2つのプロセスが同時に同じ古い札を見たとき、
 * ごく短い隙に片方が他方の新しい札を消しうる。取ったあとに読み直して
 * 自分の札か確かめ、生存の印のたびにも確かめるので、続けて2つが送る形は
 * 残らない（最悪でも1回ぶん重なる＝この仕組みを入れる前と同じ）。
 */
export class ProcessLease {
  /** いま持っている札の中身（持っていなければ undefined） */
  private heldText: string | undefined;
  private users = 0;
  private waiters = 0;
  private acquiring: Promise<LoopOutcome> | undefined;
  private readonly waitListeners = new Set<(holder: LeaseRecord) => void>();
  private heartbeat: { stop(): void } | undefined;
  private pendingRemoval: Promise<void> | undefined;

  constructor(
    private readonly env: LeaseEnvironment,
    private readonly identity: LeaseIdentity,
    private readonly options: ProcessLeaseOptions = {}
  ) {}

  /** いま札を持っているか（試験と診断用） */
  isHeld(): boolean {
    return this.heldText !== undefined;
  }

  /**
   * 札へ入る。持っていれば待たずに通し、無ければ取れるまで待つ。
   *
   * 中止されたら `AiQueueAbortError` を投げる（6.76 の関所と同じ型——
   * 受け取る側がすでに `aborted` へ言い換える作りになっている）。
   */
  async enter(label: string, options: EnterLeaseOptions = {}): Promise<LeaseEntry> {
    const { signal, onWait } = options;
    if (signal?.aborted) throw new AiQueueAbortError();

    if (this.heldText !== undefined) {
      this.users += 1;
      return { kind: "held", release: this.releaser(), fresh: false, waitedMs: 0 };
    }

    this.waiters += 1;
    if (onWait) this.waitListeners.add(onWait);
    try {
      this.acquiring ??= this.acquireLoop(label).finally(() => {
        this.acquiring = undefined;
      });
      const outcome = await raceAbort(this.acquiring, signal);
      if (outcome.kind === "unavailable") {
        return { kind: "unavailable", release: noop, reason: outcome.reason };
      }
      if (outcome.kind === "abandoned" || this.heldText === undefined) {
        // 取りに行った本人が抜けたあとで、自分だけ残っていた。取り直す
        return await this.enter(label, options);
      }
      this.users += 1;
      return {
        kind: "held",
        release: this.releaser(),
        // 取りにいった者が複数いても、「新しく取った」のは同じ1回である。
        // どちらが負荷を見ても同じ結果なので、両方に true を返す
        fresh: true,
        waitedMs: outcome.waitedMs,
        ...(outcome.waitedFor ? { waitedFor: outcome.waitedFor } : {}),
      };
    } finally {
      this.waiters -= 1;
      if (onWait) this.waitListeners.delete(onWait);
      // 誰も使わないまま取れてしまった札は離す（全員が中止で抜けたとき）
      this.releaseIfIdle();
    }
  }

  /**
   * 使う者が居なければ離す。拡張機能の側は、一括処理の札を返したあとに呼ぶ
   * （`keepWhile` が false になった瞬間を、こちらからは知れないため）。
   */
  releaseIfIdle(): void {
    if (this.heldText === undefined) return;
    if (this.users > 0 || this.waiters > 0) return;
    if (this.options.keepWhile?.()) return;
    this.drop();
  }

  /** 終わるとき。使う者が居ても離す（拡張機能の `deactivate`・MCP の終了） */
  async dispose(): Promise<void> {
    const text = this.heldText;
    this.stopHeartbeat();
    this.heldText = undefined;
    this.users = 0;
    if (text === undefined) return;
    try {
      await this.env.ops.removeIfSame(text);
    } catch (error) {
      this.env.log?.(`手元のAIの札を片づけられませんでした：${describe(error)}`);
    }
    this.options.onDropped?.();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.users = Math.max(0, this.users - 1);
      this.releaseIfIdle();
    };
  }

  private drop(): void {
    const text = this.heldText;
    this.stopHeartbeat();
    this.heldText = undefined;
    if (text === undefined) return;
    // **呼んだ側を待たせない。** 札を消すのは後片づけで、送り終えた処理を
    // 待たせる理由は無い。消せなくても、生存の印が古くなれば相手が奪える。
    // ただし終わる直前のプロセス（MCP は道具を返したら殺されうる）のために、
    // 消し終わりを `whenSettled` で待てるようにしておく
    const removal = this.env.ops
      .removeIfSame(text)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.env.log?.(`手元のAIの札を消せませんでした：${describe(error)}`);
      });
    this.pendingRemoval = removal;
    void removal.finally(() => {
      if (this.pendingRemoval === removal) this.pendingRemoval = undefined;
    });
    this.options.onDropped?.();
  }

  /**
   * 離した札の片づけが終わるまで待つ。**MCP の道具が返る前に呼ぶ**
   * （返した直後に呼び出し元がサーバーを終わらせると、札が残る。
   * 残っても相手は「持ち主の居ない札」として奪えるが、それまで待たせる）。
   */
  async whenSettled(): Promise<void> {
    await this.pendingRemoval;
  }

  private async acquireLoop(label: string): Promise<LoopOutcome> {
    const started = this.env.now();
    let waitedFor: LeaseRecord | undefined;
    for (;;) {
      if (this.waiters === 0) return { kind: "abandoned" };

      const record: LeaseRecord = {
        version: 1,
        token: this.identity.token,
        pid: this.identity.pid,
        host: this.identity.host,
        label,
        ...(this.identity.windowName ? { windowName: this.identity.windowName } : {}),
        startedAt: new Date(this.env.now()).toISOString(),
      };
      const text = serializeLease(record);

      let created: boolean;
      try {
        created = await this.env.ops.tryCreate(text);
      } catch (error) {
        return { kind: "unavailable", reason: `札を作れません（${describe(error)}）` };
      }

      if (created) {
        // **読み直して、自分の札か確かめる**（古い札の片づけと重なったとき）
        let back: { text: string; mtimeMs: number } | undefined;
        try {
          back = await this.env.ops.read();
        } catch (error) {
          return { kind: "unavailable", reason: `札を読めません（${describe(error)}）` };
        }
        if (back?.text === text) {
          this.heldText = text;
          this.startHeartbeat();
          return {
            kind: "acquired",
            waitedMs: this.env.now() - started,
            ...(waitedFor ? { waitedFor } : {}),
          };
        }
        continue;
      }

      let current: { text: string; mtimeMs: number } | undefined;
      try {
        current = await this.env.ops.read();
      } catch (error) {
        return { kind: "unavailable", reason: `札を読めません（${describe(error)}）` };
      }
      if (!current) {
        // 作ろうとした瞬間にはあり、読もうとしたら消えていた。少し置いて取り直す
        await this.env.sleep(50);
        continue;
      }

      const parsed = parseLease(current.text);
      const judgement = judgeLease({
        record: parsed,
        heartbeatMs: current.mtimeMs,
        nowMs: this.env.now(),
        selfToken: this.identity.token,
        isAlive: this.env.isAlive,
      });

      if (judgement === "mine") {
        // 自分の合言葉の札が残っていた（離したつもりの札が消せていなかった）
        this.heldText = current.text;
        this.startHeartbeat();
        return {
          kind: "acquired",
          waitedMs: this.env.now() - started,
          ...(waitedFor ? { waitedFor } : {}),
        };
      }

      if (judgement === "stale") {
        this.env.log?.(
          parsed
            ? `持ち主の居ない札を片づけます（${holderPhrase(parsed)}、プロセス ${parsed.pid}、` +
                `最後の生存の印から${Math.round((this.env.now() - current.mtimeMs) / 1000)}秒）`
            : "読めない札を片づけます（書きかけのまま残ったもの）"
        );
        try {
          await this.env.ops.removeIfSame(current.text);
        } catch (error) {
          return { kind: "unavailable", reason: `古い札を消せません（${describe(error)}）` };
        }
        continue;
      }

      // 持たれている。相手が替わったときだけ知らせる（毎回言うとログが埋まる）
      if (parsed && parsed.token !== waitedFor?.token) {
        waitedFor = parsed;
        for (const listener of this.waitListeners) listener(parsed);
      }
      await this.env.sleep(LEASE_POLL_MS);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = this.env.startTimer(() => void this.beat(), LEASE_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = undefined;
  }

  /**
   * 生存の印を打つ。ついでに「まだ自分の札か」を確かめ、使う者が居なければ離す
   * （一括処理の終わりを知らせ損ねた道があっても、ここで拾える）。
   */
  private async beat(): Promise<void> {
    const text = this.heldText;
    if (text === undefined) return;
    if (this.users === 0 && this.waiters === 0 && !this.options.keepWhile?.()) {
      this.drop();
      return;
    }
    try {
      const current = await this.env.ops.read();
      if (this.heldText !== text) return;
      if (current?.text !== text) {
        // 奪われた（機械が眠っていて印が古くなった、など）。持っていないことにする。
        // **送っている最中の処理は止めない**——止めるほうが作者の損が大きい
        this.env.log?.(
          "手元のAIの札が、ほかのプロセスに取られていました（生存の印が遅れた可能性があります）。" +
            "次に送るときに取り直します。"
        );
        this.stopHeartbeat();
        this.heldText = undefined;
        this.options.onDropped?.();
        return;
      }
      await this.env.ops.touch();
    } catch (error) {
      this.env.log?.(`手元のAIの札の生存の印を打てませんでした：${describe(error)}`);
    }
  }
}

/** 待ちを中止で抜ける。**待っている本体は止めない**（ほかの者が同じものを待っている） */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AiQueueAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AiQueueAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
