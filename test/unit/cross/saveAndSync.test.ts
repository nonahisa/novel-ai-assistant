import { beforeEach, describe, expect, test, vi } from "vitest";
import { saveAndSyncAll } from "../../src/features/handoffSync";
import type { GitSyncStatus } from "../../src/core/git";
import type { WorkRegistry } from "../../src/core/workRegistry";
import type { GitSyncMonitorLike } from "../../src/features/gitSyncStub";
import type { WorkEntry } from "../../src/models/types";
import { UNSENT_MARK_KEY } from "../../src/core/unsentMark";
import { window, workspace } from "./support/vscodeStub";

/**
 * 「保存して同期」（設計書6.15.1の②）。**1押しで 保存 → 記録 → 送信。**
 *
 * **ここは作者が「送った」と言い切るための口**である。途中で黙って止まると、
 * 送ったつもりの原稿が別の機械から見えないまま残る——だから見たいのは
 * **何を呼んだかではなく、呼んだ順番と、呼ばなかった場面**である。
 *
 * 記録と送信そのものは「作品をすべて同期」に任せる作りなので、そちらは
 * 作り物に差し替えて、**渡ったかどうかだけ**を見る（中身は
 * `syncAllWorksRun.test.ts` が見ている）。
 */

/** 「作品をすべて同期」が呼ばれた回数（作り物） */
let syncCalls = 0;

vi.mock("../../src/features/syncAllWorks", () => ({
  syncAllWorks: async () => {
    syncCalls += 1;
    order.push("sync");
  },
}));

/** 呼ばれた順番。**保存が先でなければ意味が無い** */
let order: string[] = [];

const works: WorkEntry[] = [
  { id: "w1", title: "いじめられっ子", folderPath: "C:/書庫/いじめられっ子" },
] as WorkEntry[];

const registry = { list: () => works } as unknown as WorkRegistry;

function tracked(
  over: Partial<Extract<GitSyncStatus, { kind: "tracked" }>> = {}
): GitSyncStatus {
  return {
    kind: "tracked",
    root: "C:/書庫",
    branch: "main",
    upstream: "origin/main",
    behind: 0,
    ahead: 0,
    behindHere: 0,
    aheadHere: 0,
    dirty: 0,
    dirtyHere: 0,
    unmerged: 0,
    ...over,
  };
}

function monitorWith(status: GitSyncStatus): GitSyncMonitorLike {
  return {
    refreshAll: async () => {},
    statusFor: () => status,
  } as unknown as GitSyncMonitorLike;
}

function memoryStorage(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    get<T>(key: string): T | undefined {
      return store[key] as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) delete store[key];
      else store[key] = value;
    },
    raw: () => store,
  };
}

/** 保存しきれなかったときに出た確認の文言（最後の1件） */
let warned: string | undefined;
/** その確認で作者が押したもの */
let answer: string | undefined;

function depsWith(status: GitSyncStatus, storage = memoryStorage()) {
  return {
    registry,
    monitor: monitorWith(status),
    storage,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}

beforeEach(() => {
  syncCalls = 0;
  order = [];
  warned = undefined;
  answer = undefined;
  workspace.saveAll = (async () => {
    order.push("save");
    return true;
  }) as typeof workspace.saveAll;
  window.showWarningMessage = (async (message: string) => {
    warned = message;
    return answer;
  }) as typeof window.showWarningMessage;
});

describe("1押しで 保存 → 記録 → 送信", () => {
  test("先に保存してから、まとめて同期する", async () => {
    await saveAndSyncAll(depsWith(tracked({ dirty: 1 })));

    // **順番が命。** 同期が先だと、書きかけが入らないまま送られる
    expect(order).toEqual(["save", "sync"]);
  });

  test("送るものが無くても、保存と同期は通す", async () => {
    // 作者は「送った」と言い切りたくて押す。**空振りでも黙って通す**
    await saveAndSyncAll(depsWith(tracked()));

    expect(order).toEqual(["save", "sync"]);
  });

  test("保存できていれば、確認は出さない", async () => {
    await saveAndSyncAll(depsWith(tracked({ dirty: 1 })));

    expect(warned).toBeUndefined();
  });
});

describe("保存しきれなかったとき", () => {
  beforeEach(() => {
    workspace.saveAll = (async () => {
      order.push("save");
      return false;
    }) as typeof workspace.saveAll;
  });

  test("そのまま同期してよいか訊く", async () => {
    await saveAndSyncAll(depsWith(tracked({ dirty: 1 })));

    expect(warned).toContain("保存できなかったファイルがあります");
  });

  test("「このまま同期する」なら、送れるぶんは送る", async () => {
    answer = "このまま同期する";

    await saveAndSyncAll(depsWith(tracked({ dirty: 1 })));

    expect(syncCalls).toBe(1);
  });

  test("断れば、記録も送信もしない", async () => {
    // **押さずに閉じたのと同じ扱い。** 勝手に送らない
    answer = undefined;

    await saveAndSyncAll(depsWith(tracked({ dirty: 1 })));

    expect(syncCalls).toBe(0);
    expect(order).toEqual(["save"]);
  });
});

describe("済んだあとの「送らずに閉じた」印", () => {
  test("送り残しが残っていれば、印を付け直す", async () => {
    // 同期を作り物にしているので、状態は送る前のまま＝送り残しが残る形
    const storage = memoryStorage();

    await saveAndSyncAll(depsWith(tracked({ ahead: 2 }), storage));

    expect(storage.raw()[UNSENT_MARK_KEY]).toBeDefined();
  });

  test("送り残しが無くなっていれば、印を消す", async () => {
    const storage = memoryStorage({
      [UNSENT_MARK_KEY]: {
        at: "2026-09-21T00:00:00.000Z",
        ahead: 3,
        dirty: 0,
        labels: ["書庫"],
      },
    });

    await saveAndSyncAll(depsWith(tracked(), storage));

    expect(storage.raw()[UNSENT_MARK_KEY]).toBeUndefined();
  });
});
