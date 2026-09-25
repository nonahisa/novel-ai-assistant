import { describe, expect, test } from "vitest";
import { AiQueueAbortError } from "../../../src/core/aiSequence";
import {
  LEASE_HEARTBEAT_MS,
  LEASE_STALE_MS,
  LEASE_UNREADABLE_GRACE_MS,
  ProcessLease,
  holderPhrase,
  judgeLease,
  leaseWaitingMessage,
  parseLease,
  serializeLease,
  type LeaseEnvironment,
  type LeaseFileOps,
  type LeaseRecord,
} from "../../../src/core/localAiLease";

/**
 * 手元のAIの札（設計書6.76.1）。**プロセスをまたいだ順番待ち**を、
 * 1つの「札のファイル」を共有する2つの `ProcessLease` で確かめる。
 *
 * 「動いた」と言える条件（先に決めたもの）：
 * 1. 空いていれば取れる。取っている間、別のプロセスは待ち、待ちの相手を知らされる
 * 2. 持ち主が離せば、待っていた側が取れる（待った相手と長さが分かる）
 * 3. 死んだ持ち主（プロセスが居ない・生存の印が古い）の札は奪える。
 *    **生きている持ち主からは奪わない**
 * 4. 待っている最中に中止できる。中止しても相手の札を壊さない
 * 5. 札のファイルが扱えなければ「札なし」を返す（呼ぶ側は今までどおり送る）
 * 6. 同じプロセスの中は数で共有し、一括処理の間（keepWhile）は離さない
 */

/** 1台の機械（1つの札のファイルと、時計と、生きているプロセス） */
class FakeMachine {
  now = 1_000_000;
  file: { text: string; mtimeMs: number } | undefined;
  readonly alive = new Set<number>();
  private readonly timers: Array<{ due: number; every: number; tick: () => void; live: boolean }> = [];
  /** tryCreate を壊す（札のファイルが扱えない機械） */
  broken = false;

  ops(): LeaseFileOps {
    return {
      tryCreate: async (text) => {
        if (this.broken) throw new Error("EACCES: 書き込めません");
        if (this.file) return false;
        this.file = { text, mtimeMs: this.now };
        return true;
      },
      read: async () => (this.file ? { ...this.file } : undefined),
      removeIfSame: async (text) => {
        if (!this.file) return true;
        if (this.file.text !== text) return false;
        this.file = undefined;
        return true;
      },
      touch: async () => {
        if (this.file) this.file.mtimeMs = this.now;
      },
    };
  }

  /** 時間を進めて、来た時計を鳴らす */
  advance(ms: number): void {
    this.now += ms;
    for (const timer of this.timers) {
      while (timer.live && timer.due <= this.now) {
        timer.due += timer.every;
        timer.tick();
      }
    }
  }

  env(): LeaseEnvironment {
    return {
      ops: this.ops(),
      now: () => this.now,
      isAlive: (pid) => this.alive.has(pid),
      // 待つ＝時間を進めて、ほかの約束が進む隙を作る
      sleep: async (ms) => {
        this.advance(ms);
        await new Promise((resolve) => setImmediate(resolve));
      },
      startTimer: (tick, every) => {
        const timer = { due: this.now + every, every, tick, live: true };
        this.timers.push(timer);
        return { stop: () => void (timer.live = false) };
      },
    };
  }

  process(pid: number, host: "extension" | "mcp" = "extension", keepWhile?: () => boolean) {
    this.alive.add(pid);
    return new ProcessLease(
      this.env(),
      { pid, host, token: `token-${pid}`, windowName: host === "extension" ? `窓${pid}` : undefined },
      keepWhile ? { keepWhile } : {}
    );
  }
}

async function turns(count = 20): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("札の取り合い", () => {
  test("空いていれば取れる。札には名乗りが書かれる", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const entry = await a.enter("誤字脱字の検知");
    expect(entry.kind).toBe("held");
    if (entry.kind !== "held") return;
    expect(entry.fresh).toBe(true);
    expect(entry.waitedMs).toBe(0);
    const record = parseLease(machine.file!.text);
    expect(record).toMatchObject({
      pid: 101,
      host: "extension",
      label: "誤字脱字の検知",
      windowName: "窓101",
    });
    entry.release();
    expect(machine.file).toBeUndefined();
  });

  test("持たれている間は待ち、相手を知らされる。離されたら取れる", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202, "mcp");
    const held = await a.enter("誤字脱字の検知");

    const seen: LeaseRecord[] = [];
    let bDone = false;
    const bEntry = b
      .enter("推敲", { onWait: (holder) => seen.push(holder) })
      .then((entry) => {
        bDone = true;
        return entry;
      });

    // 1回見に行くたびに時計が1秒進む。60秒の線を越えるまで回す
    while (machine.now - 1_000_000 <= LEASE_STALE_MS * 2) await turns(1);
    // 生存の印が打たれ続けるので、何十秒待っても奪わない
    expect(bDone).toBe(false);
    expect(machine.now - 1_000_000).toBeGreaterThan(LEASE_STALE_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0].label).toBe("誤字脱字の検知");
    expect(leaseWaitingMessage(seen[0])).toBe(
      "別の窓（窓101）の「誤字脱字の検知」の完了を待っています…"
    );

    held.release();
    const entry = await bEntry;
    expect(entry.kind).toBe("held");
    if (entry.kind !== "held") return;
    expect(entry.fresh).toBe(true);
    expect(entry.waitedFor?.pid).toBe(101);
    expect(entry.waitedMs).toBeGreaterThan(0);
    expect(parseLease(machine.file!.text)?.host).toBe("mcp");
    entry.release();
  });

  test("同時に取りにいっても、取れるのは片方だけ", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202);
    const results: string[] = [];
    const pa = a.enter("A").then((entry) => {
      results.push("A");
      return entry;
    });
    const pb = b.enter("B").then((entry) => {
      results.push("B");
      return entry;
    });
    await turns(5);
    expect(results).toHaveLength(1);
    const first = results[0] === "A" ? await pa : await pb;
    first.release();
    const second = results[0] === "A" ? await pb : await pa;
    expect(results).toHaveLength(2);
    second.release();
    expect(machine.file).toBeUndefined();
  });
});

describe("古い札の奪取", () => {
  test("持ち主のプロセスが居なければ、すぐ奪える", async () => {
    const machine = new FakeMachine();
    const dead: LeaseRecord = {
      version: 1,
      token: "dead",
      pid: 999,
      host: "extension",
      label: "落ちた窓",
      startedAt: new Date(machine.now).toISOString(),
    };
    machine.file = { text: serializeLease(dead), mtimeMs: machine.now };
    const b = machine.process(202);
    const entry = await b.enter("推敲");
    expect(entry.kind).toBe("held");
    expect(parseLease(machine.file!.text)?.pid).toBe(202);
  });

  test("生存の印が古ければ、プロセスの生死が分からなくても奪える", async () => {
    const machine = new FakeMachine();
    const record: LeaseRecord = {
      version: 1,
      token: "old",
      pid: 303,
      host: "mcp",
      label: "番号を使い回された",
      startedAt: new Date(machine.now).toISOString(),
    };
    machine.alive.add(303);
    machine.file = { text: serializeLease(record), mtimeMs: machine.now - LEASE_STALE_MS };
    const entry = await machine.process(202).enter("推敲");
    expect(entry.kind).toBe("held");
  });

  test("読めない札は、少しだけ書きかけとして待ち、過ぎたら片づける", () => {
    const base = { selfToken: "me", isAlive: () => true };
    expect(
      judgeLease({ ...base, record: undefined, heartbeatMs: 0, nowMs: LEASE_UNREADABLE_GRACE_MS - 1 })
    ).toBe("held");
    expect(
      judgeLease({ ...base, record: undefined, heartbeatMs: 0, nowMs: LEASE_UNREADABLE_GRACE_MS })
    ).toBe("stale");
  });

  test("生きていて印も新しい札は奪わない。分からないときも印が新しければ奪わない", () => {
    const record = parseLease(
      serializeLease({
        version: 1,
        token: "other",
        pid: 5,
        host: "extension",
        label: "x",
        startedAt: "2026-09-25T00:00:00.000Z",
      })
    );
    const at = { record, heartbeatMs: 0, nowMs: LEASE_STALE_MS - 1, selfToken: "me" };
    expect(judgeLease({ ...at, isAlive: () => true })).toBe("held");
    expect(judgeLease({ ...at, isAlive: () => undefined })).toBe("held");
    expect(judgeLease({ ...at, isAlive: () => false })).toBe("stale");
    expect(judgeLease({ ...at, selfToken: "other", isAlive: () => true })).toBe("mine");
  });
});

describe("中止", () => {
  test("待っている最中に中止すると AiQueueAbortError。相手の札は壊さない", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const held = await a.enter("誤字脱字の検知");
    const controller = new AbortController();
    const waiting = machine.process(202).enter("推敲", { signal: controller.signal });
    await turns(3);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AiQueueAbortError);
    await turns(3);
    expect(parseLease(machine.file!.text)?.pid).toBe(101);
    held.release();
    expect(machine.file).toBeUndefined();
  });

  test("中止済みの合図で来たら、並ばずに断る", async () => {
    const machine = new FakeMachine();
    const controller = new AbortController();
    controller.abort();
    await expect(
      machine.process(101).enter("x", { signal: controller.signal })
    ).rejects.toBeInstanceOf(AiQueueAbortError);
    expect(machine.file).toBeUndefined();
  });
});

describe("札が扱えないとき", () => {
  test("作れなければ「札なし」を返す（呼ぶ側は今までどおり送る）", async () => {
    const machine = new FakeMachine();
    machine.broken = true;
    const entry = await machine.process(101).enter("x");
    expect(entry.kind).toBe("unavailable");
    if (entry.kind === "unavailable") {
      expect(entry.reason).toContain("EACCES");
      entry.release();
    }
  });
});

describe("同じプロセスの中", () => {
  test("持っている間は待たずに通し、数で共有する", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const first = await a.enter("A");
    const second = await a.enter("B");
    expect(second.kind === "held" && second.fresh).toBe(false);
    first.release();
    expect(machine.file).toBeDefined();
    second.release();
    // 二度呼んでも数が崩れない
    second.release();
    expect(machine.file).toBeUndefined();
  });

  test("一括処理の間（keepWhile）は離さず、終わってから releaseIfIdle で離す", async () => {
    const machine = new FakeMachine();
    let running = true;
    const a = machine.process(101, "extension", () => running);
    const entry = await a.enter("誤字脱字の検知");
    entry.release();
    expect(a.isHeld()).toBe(true);
    // 2回目の呼び出しは「新しく取った」ではない（負荷を見直さない）
    const again = await a.enter("誤字脱字の検知");
    expect(again.kind === "held" && again.fresh).toBe(false);
    again.release();
    running = false;
    a.releaseIfIdle();
    expect(a.isHeld()).toBe(false);
    expect(machine.file).toBeUndefined();
  });

  test("終わりを知らせ損ねても、生存の印のときに離す", async () => {
    const machine = new FakeMachine();
    let running = true;
    const a = machine.process(101, "extension", () => running);
    (await a.enter("x")).release();
    running = false;
    machine.advance(LEASE_HEARTBEAT_MS);
    await turns(3);
    expect(machine.file).toBeUndefined();
  });

  test("生存の印は最終更新時刻を打ち直す。奪われていたら持っていないことにする", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    await a.enter("x");
    machine.advance(LEASE_HEARTBEAT_MS);
    await turns(3);
    expect(machine.file!.mtimeMs).toBe(machine.now);
    machine.file = { text: "{}", mtimeMs: machine.now };
    machine.advance(LEASE_HEARTBEAT_MS);
    await turns(3);
    expect(a.isHeld()).toBe(false);
  });
});

describe("離してすぐ取り直す（送信の札はチャンクごとに離す。6.76.1 の追記）", () => {
  test("離した札の片づけが済むまで取りにいかない（消えかけの自分の札を拾わない）", async () => {
    const machine = new FakeMachine();
    // 片づけ（removeIfSame）を手で進める機械にする
    const env = machine.env();
    let finishRemoval: (() => void) | undefined;
    const slowEnv: LeaseEnvironment = {
      ...env,
      ops: {
        ...env.ops,
        removeIfSame: async (text) => {
          await new Promise<void>((resolve) => {
            finishRemoval = resolve;
          });
          return env.ops.removeIfSame(text);
        },
      },
    };
    machine.alive.add(101);
    const a = new ProcessLease(slowEnv, { pid: 101, host: "extension", token: "token-101" });
    const b = machine.process(202);

    (await a.enter("1チャンク目")).release();
    // 片づけが済まないうちに、2チャンク目を取りにいく
    let aDone = false;
    const again = a.enter("2チャンク目").then((entry) => {
      aDone = true;
      return entry;
    });
    await turns();
    expect(aDone).toBe(false);
    finishRemoval?.();
    const entry = await again;
    expect(entry.kind).toBe("held");
    // 取り直した札が、ちゃんとファイルに残っている（拾ってすぐ消えた、ではない）
    expect(parseLease(machine.file!.text)?.label).toBe("2チャンク目");
    // B は取れない（2つが同時に送らない）
    let bDone = false;
    void b.enter("相談").then(() => {
      bDone = true;
    });
    await turns();
    expect(bDone).toBe(false);
  });

  test("あとから並んだ者にも、待たせている相手をすぐ知らせる", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202);
    await a.enter("誤字脱字の検知");
    const first: LeaseRecord[] = [];
    void b.enter("相談", { onWait: (holder) => first.push(holder) });
    await turns();
    expect(first).toHaveLength(1);
    const late: LeaseRecord[] = [];
    void b.enter("単発の生成", { onWait: (holder) => late.push(holder) });
    await turns();
    expect(late.map((holder) => holder.label)).toEqual(["誤字脱字の検知"]);
  });
});

describe("札の読み書きと言い方", () => {
  test("書いたものが読める。欠けたもの・壊れたものは読まない", () => {
    const record: LeaseRecord = {
      version: 1,
      token: "t",
      pid: 1,
      host: "mcp",
      label: "推敲",
      startedAt: "2026-09-25T00:00:00.000Z",
    };
    expect(parseLease(serializeLease(record))).toEqual(record);
    expect(parseLease("")).toBeUndefined();
    expect(parseLease("{")).toBeUndefined();
    expect(parseLease(JSON.stringify({ ...record, version: 2 }))).toBeUndefined();
    expect(parseLease(JSON.stringify({ ...record, pid: "1" }))).toBeUndefined();
  });

  test("窓か MCP かで言い分ける", () => {
    const base = {
      version: 1 as const,
      token: "t",
      pid: 1,
      label: "誤字脱字の検知",
      startedAt: "",
    };
    expect(holderPhrase({ ...base, host: "extension" })).toBe("別の窓の「誤字脱字の検知」");
    expect(holderPhrase({ ...base, host: "extension", windowName: "作品A" })).toBe(
      "別の窓（作品A）の「誤字脱字の検知」"
    );
    expect(holderPhrase({ ...base, host: "mcp" })).toBe("外部AI（MCP）の「誤字脱字の検知」");
  });
});
