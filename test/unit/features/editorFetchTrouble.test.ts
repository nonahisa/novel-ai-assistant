import { beforeEach, describe, expect, test, vi } from "vitest";
import { commands, window } from "../support/vscodeStub";
import type { GitCommandRunner } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 編集者の側で、取りに行きが失敗したあとの見分けと知らせ（設計書5.7.5.4。作者の決定 2026-11-07）。
 *
 * - 開いたときの自動の取りに行きでは、置き場に届かないときだけ、**同じ作品で1回だけ**知らせる
 * - API を引くのは失敗したときだけ、作品ごとに10分に1回まで
 * - 押した操作では毎回見分けて、回線も分けて知らせる
 */

vi.mock("../../../src/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/logger")>();
  return { ...actual, logStep: () => undefined, logFailure: () => undefined, useLogFile: () => undefined };
});

const {
  diagnoseFetchFailure,
  noticeAutoFetchFailure,
  noticeManualFetchFailure,
  resetFetchTroubleProbes,
} = await import("../../../src/features/editorFetchTrouble");
const { globalFetchTroubleMemory, rememberFetchTroubleMemory } = await import(
  "../../../src/features/fetchTroubleMemory"
);

const work = { id: "e1", title: "預かった作品", folderPath: "C:/写し" } as WorkEntry;

const originHttps: GitCommandRunner = async (args) =>
  args[0] === "remote"
    ? { code: 0, stdout: "https://github.com/hisa/ice-editing.git\n", stderr: "" }
    : { code: 1, stdout: "", stderr: "" };

function json(status: number): Response {
  return new Response(JSON.stringify({ message: "x" }), { status });
}

const shown: Array<{ message: string; buttons: string[] }> = [];
const executed: Array<{ command: string; arg: unknown }> = [];
let pick: string | undefined;

/** 覚えの保管（`globalState` の代わり） */
function memento(): { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> } {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: async (key, value) => {
      store.set(key, value);
    },
  };
}

beforeEach(() => {
  shown.length = 0;
  executed.length = 0;
  pick = undefined;
  resetFetchTroubleProbes();
  rememberFetchTroubleMemory(memento() as never);
  commands.executeCommand = (async (command: string, arg: unknown) => {
    executed.push({ command, arg });
    return undefined;
  }) as typeof commands.executeCommand;
  Object.assign(window, {
    showWarningMessage: async (message: string, ...rest: unknown[]) => {
      const buttons = rest.filter((item): item is string => typeof item === "string");
      shown.push({ message, buttons });
      return buttons.find((button) => button === pick);
    },
  });
});

describe("見分け", () => {
  test("404→解除、通信の失敗→回線、200→分からない", async () => {
    const deps = (fetchImpl: typeof fetch) => ({ run: originHttps, token: async () => "t", fetchImpl });
    expect(await diagnoseFetchFailure(work, { auto: false }, deps(async () => json(404)))).toBe("revoked");
    expect(
      await diagnoseFetchFailure(
        work,
        { auto: false },
        deps((async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch)
      )
    ).toBe("offline");
    expect(await diagnoseFetchFailure(work, { auto: false }, deps(async () => json(200)))).toBe("unknown");
  });

  test("鍵が取れない・401 は分からない。送り先が ssh なら API を引かない", async () => {
    const fetchImpl = vi.fn(async () => json(404));
    expect(
      await diagnoseFetchFailure(work, { auto: false }, { run: originHttps, token: async () => undefined, fetchImpl })
    ).toBe("unknown");
    expect(
      await diagnoseFetchFailure(work, { auto: false }, { run: originHttps, token: async () => "t", fetchImpl: async () => json(401) })
    ).toBe("unknown");
    const ssh: GitCommandRunner = async () => ({ code: 0, stdout: "git@github.com:hisa/ice-editing.git", stderr: "" });
    expect(await diagnoseFetchFailure(work, { auto: false }, { run: ssh, token: async () => "t", fetchImpl })).toBe(
      "unknown"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("自動の取りに行きでは、作品ごとに10分に1回までしか API を引かない", async () => {
    const fetchImpl = vi.fn(async () => json(200));
    let now = 1_000_000;
    const deps = { run: originHttps, token: async () => "t", fetchImpl, now: () => now };
    await diagnoseFetchFailure(work, { auto: true }, deps);
    now += 60_000;
    await diagnoseFetchFailure(work, { auto: true }, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 10 * 60 * 1000;
    await diagnoseFetchFailure(work, { auto: true }, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("開いたときの自動の取りに行きの知らせ", () => {
  test("置き場に届かないときは、同じ作品で1回だけ知らせる。ボタンで「この作品の編集を終える」へ", async () => {
    pick = "この作品の編集を終える";
    let now = 0;
    const fetchImpl = vi.fn(async () => json(404));
    const deps = { run: originHttps, token: async () => "t", fetchImpl, now: () => now };

    expect(await noticeAutoFetchFailure(work, deps)).toBe("revoked");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.message).toContain("「預かった作品」の置き場に届きませんでした");
    expect(shown[0]?.buttons).toEqual(["この作品の編集を終える"]);
    expect(executed).toEqual([{ command: "novelai.removeWork", arg: { type: "work", work } }]);

    // 間引きの間隔を過ぎても、もう知らせた作品では出さない（API も引かない）
    now += 60 * 60 * 1000;
    expect(await noticeAutoFetchFailure(work, deps)).toBe("alreadyNotified");
    expect(shown).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("取りに行きが通って覚えを消したら、次にまた届かなくなったとき、また知らせる", async () => {
    let now = 0;
    const deps = { run: originHttps, token: async () => "t", fetchImpl: async () => json(404), now: () => now };
    await noticeAutoFetchFailure(work, deps);
    await globalFetchTroubleMemory.clear(work.id);
    now += 11 * 60 * 1000;
    await noticeAutoFetchFailure(work, deps);
    expect(shown).toHaveLength(2);
  });

  test("回線や分からないときは今までどおり黙る", async () => {
    const offline = await noticeAutoFetchFailure(work, {
      run: originHttps,
      token: async () => "t",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(offline).toBe("offline");
    resetFetchTroubleProbes();
    const unknown = await noticeAutoFetchFailure(work, {
      run: originHttps,
      token: async () => "t",
      fetchImpl: async () => json(200),
    });
    expect(unknown).toBe("unknown");
    expect(shown).toHaveLength(0);
    expect(globalFetchTroubleMemory.has(work.id)).toBe(false);
  });
});

describe("押した操作の知らせ", () => {
  test("回線なら「つながってから、もう一度押してください」。分からなければ出さない（呼ぶ側が今までの文）", async () => {
    const offline = await noticeManualFetchFailure(work, {
      run: originHttps,
      token: async () => "t",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(offline).toEqual({ trouble: "offline", shown: true });
    expect(shown[0]?.message).toContain("ネットにつながっていないようです");
    expect(shown[0]?.buttons).toEqual([]);

    const unknown = await noticeManualFetchFailure(work, {
      run: originHttps,
      token: async () => "t",
      fetchImpl: async () => json(200),
    });
    expect(unknown).toEqual({ trouble: "unknown", shown: false });
    expect(shown).toHaveLength(1);
  });

  test("解除と分かったら覚える（開いたときの自動の取りに行きで重ねない）", async () => {
    await noticeManualFetchFailure(work, { run: originHttps, token: async () => "t", fetchImpl: async () => json(404) });
    expect(globalFetchTroubleMemory.has(work.id)).toBe(true);
    expect(await noticeAutoFetchFailure(work, { run: originHttps })).toBe("alreadyNotified");
  });
});
