import { describe, expect, test } from "vitest";
import { AiQueueAbortError } from "../../../src/core/aiSequence";
import {
  LEASE_HEARTBEAT_MS,
  LEASE_POLL_MS,
  LEASE_STALE_MS,
  leaseWaitingMessage,
  parseLease,
  serializeLease,
  type LeaseEntry,
  type LeaseEnvironment,
  type LeaseFileOps,
  type LeaseRecord,
} from "../../../src/core/localAiLease";
import { CrossProcessTurn } from "../../../src/core/localAiCrossTurn";

/**
 * 手元のAIの順番を、プロセスをまたいで2段で取る（設計書6.76.1 の追記、
 * 作者の裁定 2026-09-25 午前「別の窓でも割り込めるようにする」）。
 *
 * 「動いた」と言える条件（先に決めたもの）：
 * 1. **別の窓の一括処理がまとまりの札を持っている間でも、単発はチャンクの
 *    合間に通る**——一括処理が送信の札を離してすぐ取り直しても、単発の
 *    「合間に入れてほしい」の印を見て譲る
 * 2. **一括処理どうしは待つ**——相手のチャンクの合間でも、相手の一括処理が
 *    終わるまで入らない
 * 3. 中止できる（待っている単発・譲っている一括処理・まとまりの札を待つ一括処理）。
 *    中止しても相手の札を壊さず、印を残さない
 * 4. 古い札・古い印は奪える／片づけられる。**生きている持ち主からは奪わない**
 * 5. 管理外の負荷を見る合図（fresh）は、一括処理の始めと、一括処理の外の単発だけ
 */

/** 1台の機械。札のファイルは名前ごとに持つ */
class FakeMachine {
  now = 1_000_000;
  readonly files = new Map<string, { text: string; mtimeMs: number }>();
  readonly alive = new Set<number>();
  private readonly timers: Array<{ due: number; every: number; tick: () => void; live: boolean }> = [];
  readonly logs: string[] = [];

  ops(name: string): LeaseFileOps {
    return {
      tryCreate: async (text) => {
        if (this.files.has(name)) return false;
        this.files.set(name, { text, mtimeMs: this.now });
        return true;
      },
      read: async () => {
        const file = this.files.get(name);
        return file ? { ...file } : undefined;
      },
      removeIfSame: async (text) => {
        const file = this.files.get(name);
        if (!file) return true;
        if (file.text !== text) return false;
        this.files.delete(name);
        return true;
      },
      touch: async () => {
        const file = this.files.get(name);
        if (file) file.mtimeMs = this.now;
      },
    };
  }

  advance(ms: number): void {
    this.now += ms;
    for (const timer of this.timers) {
      while (timer.live && timer.due <= this.now) {
        timer.due += timer.every;
        timer.tick();
      }
    }
  }

  env(name: string): LeaseEnvironment {
    return {
      ops: this.ops(name),
      now: () => this.now,
      isAlive: (pid) => this.alive.has(pid),
      sleep: async (ms) => {
        this.advance(ms);
        await new Promise((resolve) => setImmediate(resolve));
      },
      startTimer: (tick, every) => {
        const timer = { due: this.now + every, every, tick, live: true };
        this.timers.push(timer);
        return { stop: () => void (timer.live = false) };
      },
      log: (message) => void this.logs.push(message),
    };
  }

  /** プロセス1つ。`running` はそのプロセスの中で一括処理の札（6.76）が持たれているか */
  process(pid: number, host: "extension" | "mcp" = "extension") {
    this.alive.add(pid);
    const state = { running: false, idle: 0 };
    const turn = new CrossProcessTurn(
      { send: this.env("lease"), run: this.env("run"), interrupt: this.env("interrupt") },
      {
        pid,
        host,
        token: `token-${pid}`,
        ...(host === "extension" ? { windowName: `窓${pid}` } : {}),
      },
      { keepRunWhile: () => state.running, onIdle: () => void (state.idle += 1) }
    );
    return { turn, state };
  }

  holder(name: string): LeaseRecord | undefined {
    const file = this.files.get(name);
    return file ? parseLease(file.text) : undefined;
  }
}

async function turns(count = 20): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function held(entry: LeaseEntry): Extract<LeaseEntry, { kind: "held" }> {
  if (entry.kind !== "held") throw new Error(`札が取れていません：${entry.reason}`);
  return entry;
}

/** 約束が終わったかを外から見る */
function track<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let finished = false;
  const value = promise.finally(() => {
    finished = true;
  });
  // 失敗で終わる約束も、見張りのせいで「処理されない拒否」にしない
  value.catch(() => undefined);
  return { done: () => finished, value };
}

describe("別の窓の一括処理の合間に、単発が入る", () => {
  test("一括処理が合間ですぐ取り直しても、待っている単発へ譲る", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202);
    a.state.running = true;

    // A の一括処理の1チャンク目を送っている
    const chunk1 = held(await a.turn.enter("誤字脱字の検知", { kind: "run" }));
    expect(machine.holder("run")?.label).toBe("誤字脱字の検知");
    expect(machine.holder("lease")?.pid).toBe(101);

    // B の相談が来た。送信の札が持たれているので待ち、印を出す
    const seen: LeaseRecord[] = [];
    const single = track(
      b.turn.enter("AIへの単発の問い合わせ", {
        kind: "single",
        onWait: (holder) => seen.push(holder),
      })
    );
    await turns();
    expect(single.done()).toBe(false);
    expect(seen[0]?.pid).toBe(101);
    expect(machine.holder("interrupt")?.pid).toBe(202);

    // A の1チャンク目が終わり、**すぐ**2チャンク目を取りにいく
    chunk1.release();
    const aWaits: LeaseRecord[] = [];
    const chunk2 = track(
      a.turn.enter("誤字脱字の検知", {
        kind: "run",
        onWait: (holder) => aWaits.push(holder),
      })
    );

    // B が先に通る（A は譲る）
    const bEntry = held(await single.value);
    expect(chunk2.done()).toBe(false);
    expect(bEntry.waitedFor?.pid).toBe(101);
    expect(machine.holder("lease")?.pid).toBe(202);
    // 印は下がっている（残すと A が譲り続ける）
    await turns();
    expect(machine.files.has("interrupt")).toBe(false);
    // A は「B の単発を待っている」と知らされる（待ちの文言は今までどおりの形）
    expect(aWaits.some((holder) => holder.pid === 202)).toBe(true);
    expect(leaseWaitingMessage(aWaits.find((h) => h.pid === 202)!)).toBe(
      "別の窓（窓202）の「AIへの単発の問い合わせ」の完了を待っています…"
    );
    // **まとまりの札は A が持ったまま**（B は一括処理を待たずに入っただけ）
    expect(machine.holder("run")?.pid).toBe(101);

    // B が送り終えたら、A の2チャンク目が続く
    bEntry.release();
    const a2 = held(await chunk2.value);
    expect(machine.holder("lease")?.pid).toBe(101);
    // 2チャンク目は「新しく取った」ではない（管理外の負荷を毎チャンク見ない）
    expect(a2.fresh).toBe(false);
    a2.release();

    // A の一括処理が終わったら、まとまりの札も離す
    a.state.running = false;
    a.turn.runEnded();
    await turns();
    expect(machine.files.has("run")).toBe(false);
    expect(machine.files.has("lease")).toBe(false);
  });

  test("印が無ければ、一括処理は合間でも譲らずに続ける（空いている送信の札をすぐ取る）", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    a.state.running = true;
    const first = held(await a.turn.enter("推敲", { kind: "run" }));
    expect(first.fresh).toBe(true);
    first.release();
    const startedAt = machine.now;
    const second = held(await a.turn.enter("推敲", { kind: "run" }));
    // 待っていない（時計が進んでいない）
    expect(machine.now).toBe(startedAt);
    expect(second.waitedMs).toBe(0);
    second.release();
  });

  test("単発は、別の窓の一括処理がまとまりの札を持っていても、送信の札が空いていればすぐ通る", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202, "mcp");
    a.state.running = true;
    held(await a.turn.enter("設定資料の抽出", { kind: "run" })).release();
    expect(machine.holder("run")?.pid).toBe(101);

    const entry = held(await b.turn.enter("ollama.generate", { kind: "single" }));
    expect(entry.waitedMs).toBe(0);
    // 印は出していない（待たなかったので）
    expect(machine.files.has("interrupt")).toBe(false);
    entry.release();
  });
});

describe("一括処理どうしは、窓をまたいで順番を待つ", () => {
  test("相手のチャンクの合間でも入らず、相手の一括処理が終わってから始める", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202);
    a.state.running = true;
    b.state.running = true;

    const a1 = held(await a.turn.enter("誤字脱字の検知", { kind: "run" }));
    const seen: LeaseRecord[] = [];
    const bRun = track(
      b.turn.enter("推敲", { kind: "run", onWait: (holder) => seen.push(holder) })
    );
    await turns();
    // A の合間（送信の札は空いている）
    a1.release();
    await turns();
    expect(machine.files.has("lease")).toBe(false);
    // それでも B は入らない（まとまりの札を A が持っている）
    for (let i = 0; i < 5; i += 1) {
      machine.advance(LEASE_POLL_MS);
      await turns();
    }
    expect(bRun.done()).toBe(false);
    expect(seen[0]?.label).toBe("誤字脱字の検知");
    expect(leaseWaitingMessage(seen[0]!)).toBe(
      "別の窓（窓101）の「誤字脱字の検知」の完了を待っています…"
    );
    // A の2チャンク目も、B に割り込まれずに取れる
    const a2 = held(await a.turn.enter("誤字脱字の検知", { kind: "run" }));
    a2.release();

    // A の一括処理が終わった
    a.state.running = false;
    a.turn.runEnded();
    const bEntry = held(await bRun.value);
    expect(bEntry.fresh).toBe(true);
    expect(bEntry.waitedFor?.pid).toBe(101);
    expect(machine.holder("run")?.pid).toBe(202);
    bEntry.release();
  });

  test("一括処理が合間に入った単発を待っているあいだ、別の窓の一括処理はまとまりの札を取れない", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202);
    const c = machine.process(303);
    a.state.running = true;
    c.state.running = true;

    const a1 = held(await a.turn.enter("誤字脱字の検知", { kind: "run" }));
    const single = track(b.turn.enter("相談", { kind: "single" }));
    const cRun = track(c.turn.enter("推敲", { kind: "run" }));
    await turns();
    a1.release();
    const bEntry = held(await single.value);
    await turns();
    expect(cRun.done()).toBe(false);
    bEntry.release();
    await turns();
    expect(cRun.done()).toBe(false);
    expect(machine.holder("run")?.pid).toBe(101);
    a.state.running = false;
    a.turn.runEnded();
    held(await cRun.value).release();
  });
});

describe("中止", () => {
  test("待っている単発を中止すると AiQueueAbortError。相手の札は壊さず、印も残さない", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202);
    a.state.running = true;
    const a1 = held(await a.turn.enter("誤字脱字の検知", { kind: "run" }));
    const controller = new AbortController();
    const single = track(b.turn.enter("相談", { kind: "single", signal: controller.signal }));
    await turns();
    expect(machine.holder("interrupt")?.pid).toBe(202);
    controller.abort();
    await expect(single.value).rejects.toBeInstanceOf(AiQueueAbortError);
    await turns();
    expect(machine.files.has("interrupt")).toBe(false);
    expect(machine.holder("lease")?.pid).toBe(101);
    expect(machine.holder("run")?.pid).toBe(101);
    // 印が消えたので、A の次のチャンクは譲らずに進む
    a1.release();
    held(await a.turn.enter("誤字脱字の検知", { kind: "run" })).release();
  });

  test("単発へ譲っている一括処理を中止できる。まとまりの札は一括処理が続くあいだ持ったまま", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202);
    a.state.running = true;
    const a1 = held(await a.turn.enter("誤字脱字の検知", { kind: "run" }));
    const single = track(b.turn.enter("相談", { kind: "single" }));
    await turns();
    a1.release();
    // B が送信の札を取る前に、A の2チャンク目が譲りに入る
    const controller = new AbortController();
    const a2 = track(
      a.turn.enter("誤字脱字の検知", { kind: "run", signal: controller.signal })
    );
    const bEntry = held(await single.value);
    controller.abort();
    await expect(a2.value).rejects.toBeInstanceOf(AiQueueAbortError);
    // B の送信の札は壊れていない
    expect(machine.holder("lease")?.pid).toBe(202);
    bEntry.release();
    // 一括処理そのものが終われば、まとまりの札も離れる
    a.state.running = false;
    a.turn.runEnded();
    await turns();
    expect(machine.files.has("run")).toBe(false);
  });

  test("まとまりの札を待つ一括処理を中止しても、相手の札を壊さない", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202);
    a.state.running = true;
    held(await a.turn.enter("誤字脱字の検知", { kind: "run" })).release();
    const controller = new AbortController();
    const bRun = track(b.turn.enter("推敲", { kind: "run", signal: controller.signal }));
    await turns();
    controller.abort();
    await expect(bRun.value).rejects.toBeInstanceOf(AiQueueAbortError);
    expect(machine.holder("run")?.pid).toBe(101);
  });
});

describe("古い札・古い印", () => {
  function record(pid: number, label: string, host: "extension" | "mcp" = "extension"): string {
    return serializeLease({
      version: 1,
      token: `dead-${pid}`,
      pid,
      host,
      label,
      startedAt: "2026-09-25T00:00:00.000Z",
    });
  }

  test("落ちた窓のまとまりの札は、一括処理がすぐ奪える", async () => {
    const machine = new FakeMachine();
    machine.files.set("run", { text: record(999, "落ちた窓の誤字脱字"), mtimeMs: machine.now });
    const a = machine.process(101);
    a.state.running = true;
    const entry = held(await a.turn.enter("推敲", { kind: "run" }));
    expect(machine.holder("run")?.pid).toBe(101);
    entry.release();
  });

  test("落ちた窓の印では、一括処理は譲らない（片づけて進む）", async () => {
    const machine = new FakeMachine();
    machine.files.set("interrupt", { text: record(999, "相談"), mtimeMs: machine.now });
    const a = machine.process(101);
    a.state.running = true;
    const startedAt = machine.now;
    const entry = held(await a.turn.enter("推敲", { kind: "run" }));
    expect(machine.now).toBe(startedAt);
    expect(machine.files.has("interrupt")).toBe(false);
    entry.release();
  });

  test("生存の印が古い印も片づける。生きていて新しい印には譲る", async () => {
    const machine = new FakeMachine();
    machine.alive.add(404);
    machine.files.set("interrupt", {
      text: record(404, "相談"),
      mtimeMs: machine.now - LEASE_STALE_MS,
    });
    const a = machine.process(101);
    a.state.running = true;
    held(await a.turn.enter("推敲", { kind: "run" })).release();
    expect(machine.files.has("interrupt")).toBe(false);

    // 生きていて新しい印（印の持ち主の単発は送信の札を取りに来ない＝ずっと待つ形）
    machine.files.set("interrupt", { text: record(404, "相談"), mtimeMs: machine.now });
    const next = track(a.turn.enter("推敲", { kind: "run" }));
    machine.advance(LEASE_POLL_MS);
    await turns();
    expect(next.done()).toBe(false);
    // 印の持ち主が落ちた
    machine.alive.delete(404);
    machine.advance(LEASE_POLL_MS);
    held(await next.value).release();
  });

  test("待っている単発は印の生存の印を打ち続け、長く待っても片づけられない", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    const b = machine.process(202);
    a.state.running = true;
    const a1 = held(await a.turn.enter("誤字脱字の検知", { kind: "run" }));
    const single = track(b.turn.enter("相談", { kind: "single" }));
    // 送信が長い（2分）。B は1秒ごとに見に来て、印の生存の印を打つ
    while (machine.now - 1_000_000 < LEASE_STALE_MS * 2) {
      machine.advance(LEASE_HEARTBEAT_MS / 10);
      await turns(3);
    }
    expect(single.done()).toBe(false);
    const marker = machine.files.get("interrupt");
    expect(marker && machine.now - marker.mtimeMs).toBeLessThan(LEASE_STALE_MS);
    a1.release();
    const chunk2 = track(a.turn.enter("誤字脱字の検知", { kind: "run" }));
    held(await single.value).release();
    held(await chunk2.value).release();
  });
});

describe("管理外の負荷を見る合図（fresh）", () => {
  test("自分の窓の一括処理の最中の単発は fresh にしない。一括処理の外の単発は fresh", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    a.state.running = true;
    held(await a.turn.enter("誤字脱字の検知", { kind: "run" })).release();
    const during = held(await a.turn.enter("相談", { kind: "single" }));
    expect(during.fresh).toBe(false);
    during.release();
    a.state.running = false;
    a.turn.runEnded();
    await turns();
    const after = held(await a.turn.enter("相談", { kind: "single" }));
    expect(after.fresh).toBe(true);
    after.release();
  });

  test("札を離し切ったら onIdle（［このまま送る］の「その実行のあいだ」を解く）", async () => {
    const machine = new FakeMachine();
    const a = machine.process(101);
    a.state.running = true;
    held(await a.turn.enter("誤字脱字の検知", { kind: "run" })).release();
    // 送信の札は離したが、まとまりの札は持っている＝まだ実行のあいだ
    expect(a.state.idle).toBe(0);
    a.state.running = false;
    a.turn.runEnded();
    expect(a.state.idle).toBe(1);
  });
});
