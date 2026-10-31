import { describe, expect, test, vi } from "vitest";
import {
  LmAvailabilityGate,
  parseLmAvailabilityRecord,
  planLmAvailability,
  type LmAvailabilityRecord,
  type LmProbeResult,
} from "../../../src/core/lmAvailability";

/**
 * VS Code のAIの口が働くかの門番（設計書5.9）。
 *
 * 作者の決まり（2026-10-31）：
 * - 起動を遅くしない（起動では待たない）
 * - 「一回消したものは、戻さないようにお願いします」
 * - 「拡張機能の版が上がったときにだけ確かめ直しましょう」
 */

/** globalState の代わり。書いたものは次の起動で読める */
function makeStore(initial?: LmAvailabilityRecord) {
  let value: unknown = initial;
  return {
    read: () => value,
    write: vi.fn((record: LmAvailabilityRecord) => {
      value = record;
    }),
    get value() {
      return value;
    },
  };
}

function makeGate(options: {
  store: ReturnType<typeof makeStore>;
  version: string;
  probe: () => Promise<LmProbeResult | undefined>;
  timeoutMs?: number;
}) {
  const published: boolean[] = [];
  const probe = vi.fn(options.probe);
  const gate = new LmAvailabilityGate({
    version: options.version,
    read: options.store.read,
    write: options.store.write,
    publish: (show) => published.push(show),
    probe,
    timeoutMs: options.timeoutMs,
  });
  return { gate, published, probe };
}

describe("残した判断の読み方", () => {
  test("形が違えば残っていない扱い", () => {
    expect(parseLmAvailabilityRecord(undefined)).toBeUndefined();
    expect(parseLmAvailabilityRecord({ available: "yes", version: "1" })).toBeUndefined();
    expect(parseLmAvailabilityRecord({ available: true })).toBeUndefined();
    expect(parseLmAvailabilityRecord({ available: false, version: "1.0.0" })).toEqual({
      available: false,
      version: "1.0.0",
    });
  });

  test("起動の表示：残っていなければ出して確かめる・同じ版は確かめない・違う版は前の値で確かめ直す", () => {
    expect(planLmAvailability(undefined, "1.0.0")).toEqual({ show: true, recheck: true });
    expect(planLmAvailability({ available: false, version: "1.0.0" }, "1.0.0")).toEqual({
      show: false,
      recheck: false,
    });
    expect(planLmAvailability({ available: false, version: "1.0.0" }, "1.0.1")).toEqual({
      show: false,
      recheck: true,
    });
  });
});

describe("起動の道で待たない", () => {
  test("start() は確かめを呼ばずに、同期で印を立てる", () => {
    // 返ってこない確かめでも、start は終わる
    const { gate, published, probe } = makeGate({
      store: makeStore(),
      version: "1.0.0",
      probe: () => new Promise(() => undefined),
    });
    gate.start();
    expect(probe).not.toHaveBeenCalled();
    expect(published).toEqual([true]);
    expect(gate.visible).toBe(true);
  });

  test("時間の上限を過ぎたら「使える」のまま残し、書き残さない", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const { gate, published } = makeGate({
        store,
        version: "1.0.0",
        probe: () => new Promise(() => undefined),
        timeoutMs: 50,
      });
      gate.start();
      const running = gate.recheckInBackground();
      await vi.advanceTimersByTimeAsync(60);
      await running;
      expect(gate.visible).toBe(true);
      expect(published).toEqual([true]);
      expect(store.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("確かめが投げたら判断しない（隠さない）", async () => {
    const store = makeStore();
    const { gate } = makeGate({
      store,
      version: "1.0.0",
      probe: () => Promise.reject(new Error("壊れた")),
    });
    gate.start();
    await gate.recheckInBackground();
    expect(gate.visible).toBe(true);
    expect(store.write).not.toHaveBeenCalled();
  });
});

describe("一度隠したら戻さない（作者の指示 2026-10-31）", () => {
  test("使えないと出たら隠し、版と一緒に残す", async () => {
    const store = makeStore();
    const { gate, published } = makeGate({
      store,
      version: "1.0.0",
      probe: async () => "unavailable",
    });
    gate.start();
    await gate.recheckInBackground();
    expect(gate.visible).toBe(false);
    expect(published).toEqual([true, false]);
    expect(store.value).toEqual({ available: false, version: "1.0.0" });
  });

  test("隠したあとに「使える」と返っても、同じセッションでは印が戻らない", async () => {
    const store = makeStore();
    let answer: LmProbeResult = "unavailable";
    const { gate, published, probe } = makeGate({
      store,
      version: "1.0.0",
      probe: async () => answer,
    });
    gate.start();
    await gate.recheckInBackground();
    answer = "available";
    // もう一度起こされても確かめない（1セッションに1回）
    await gate.recheckInBackground();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(gate.visible).toBe(false);
    expect(published).toEqual([true, false]);
  });

  test("次の起動（同じ版）は、最初から隠れていて確かめない", async () => {
    const store = makeStore();
    const first = makeGate({ store, version: "1.0.0", probe: async () => "unavailable" });
    first.gate.start();
    await first.gate.recheckInBackground();

    const second = makeGate({ store, version: "1.0.0", probe: async () => "available" });
    second.gate.start();
    // 起動の最初の印が「隠す」（一瞬見えてから消える、が起きない）
    expect(second.published).toEqual([false]);
    await second.gate.recheckInBackground();
    expect(second.probe).not.toHaveBeenCalled();
    expect(second.gate.visible).toBe(false);
  });

  test("同じ版で「使える」と残っていれば、確かめずに出す", async () => {
    const store = makeStore({ available: true, version: "1.0.0" });
    const { gate, probe, published } = makeGate({
      store,
      version: "1.0.0",
      probe: async () => "unavailable",
    });
    gate.start();
    await gate.recheckInBackground();
    expect(probe).not.toHaveBeenCalled();
    expect(published).toEqual([true]);
  });
});

describe("版が上がったときだけ確かめ直す（作者の指示 2026-10-31）", () => {
  test("版が違うと1回だけ確かめ、確かめ直すまでは隠したまま", async () => {
    const store = makeStore({ available: false, version: "1.0.0" });
    let release: (value: LmProbeResult) => void = () => undefined;
    const { gate, published, probe } = makeGate({
      store,
      version: "1.1.0",
      probe: () =>
        new Promise<LmProbeResult>((resolve) => {
          release = resolve;
        }),
    });
    gate.start();
    expect(gate.visible).toBe(false);
    const running = gate.recheckInBackground();
    // 答えが来るまでは前の結果（隠したまま）
    expect(gate.visible).toBe(false);
    expect(published).toEqual([false]);
    release("available");
    await running;
    // 版が上がったときの1回だけは戻ってよい
    expect(gate.visible).toBe(true);
    expect(published).toEqual([false, true]);
    expect(store.value).toEqual({ available: true, version: "1.1.0" });

    await gate.recheckInBackground();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("版が違っても、使えないままなら隠したまま新しい版で残す", async () => {
    const store = makeStore({ available: false, version: "1.0.0" });
    const { gate, published } = makeGate({
      store,
      version: "1.1.0",
      probe: async () => "unavailable",
    });
    gate.start();
    await gate.recheckInBackground();
    expect(gate.visible).toBe(false);
    expect(published).toEqual([false]);
    expect(store.value).toEqual({ available: false, version: "1.1.0" });
  });

  test("版が違って、確かめが時間切れなら、前の結果（隠したまま）で残す", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore({ available: false, version: "1.0.0" });
      const { gate } = makeGate({
        store,
        version: "1.1.0",
        probe: () => new Promise(() => undefined),
        timeoutMs: 50,
      });
      gate.start();
      const running = gate.recheckInBackground();
      await vi.advanceTimersByTimeAsync(60);
      await running;
      expect(gate.visible).toBe(false);
      expect(store.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("表示の変化を知らせる", () => {
  test("隠したら聞き手に届く", async () => {
    const { gate } = makeGate({
      store: makeStore(),
      version: "1.0.0",
      probe: async () => "unavailable",
    });
    const heard: boolean[] = [];
    gate.onDidChange((show) => heard.push(show));
    gate.start();
    await gate.recheckInBackground();
    expect(heard).toEqual([true, false]);
  });
});
