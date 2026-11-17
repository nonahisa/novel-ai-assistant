import { describe, expect, test, vi } from "vitest";
import {
  GLOBAL_STATE_SYNC_KEYS,
  STARTUP_REFRESH_DELAY_MS,
  SYNCED_WORKS_KEY,
  SyncedWorkList,
  activateSyncedWorkList,
  type SyncedWorkState,
} from "../../../src/features/syncedWorkList";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 作品の一覧を設定の同期で運ぶ配線（設計書5.5.11.1）。
 *
 * - 同期の鍵を VS Code へ渡す
 * - この機械の作品の origin を読み、届いている一覧へ足す（別の機械の分を消さない）
 * - ブラウザ版・編集者モードでは読みも書きもせず、並べない
 * - 壊れた中身は上書きしない
 */

function memoryState(initial?: unknown): SyncedWorkState & { value: unknown; writes: number } {
  const box = {
    value: initial,
    writes: 0,
    get<T>(key: string): T | undefined {
      expect(key).toBe(SYNCED_WORKS_KEY);
      return box.value as T | undefined;
    },
    async patch<T>(key: string, defaultValue: T, change: (current: T) => T): Promise<T> {
      expect(key).toBe(SYNCED_WORKS_KEY);
      box.writes++;
      box.value = change((box.value ?? defaultValue) as T);
      return box.value as T;
    },
  };
  return box;
}

function work(id: string, title: string, extra: Partial<WorkEntry> = {}): WorkEntry {
  return {
    id,
    title,
    folderPath: `C:/novels/${id}`,
    registeredAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

const otherMachine = {
  version: 1,
  works: [
    {
      title: "別の機械の作品",
      remoteUrl: "https://github.com/nonahisa/betsu",
      addedAt: "2026-11-02T00:00:00.000Z",
    },
  ],
};

const origins: Record<string, string | undefined> = {
  "C:/novels/hoshi": "https://x:ghp_secret@github.com/nonahisa/hoshi.git",
  "C:/novels/nogit": undefined,
};

function listWith(
  state: SyncedWorkState,
  works: WorkEntry[],
  enabled = true,
  onUnreadable?: (reason: string) => void
): SyncedWorkList {
  return new SyncedWorkList({
    state,
    works: () => works,
    enabled: () => enabled,
    readOrigin: async (folder) => origins[folder],
    now: () => "2026-11-17T00:00:00.000Z",
    onUnreadable,
  });
}

describe("同期の鍵", () => {
  test("setKeysForSync に一覧の鍵が渡り、起動のあと少し待ってから読む", () => {
    vi.useFakeTimers();
    try {
      const setKeysForSync = vi.fn();
      const list = listWith(memoryState(), []);
      const refresh = vi.spyOn(list, "refresh").mockResolvedValue();
      let fireChange: (() => void) | undefined;
      const disposable = activateSyncedWorkList(setKeysForSync, list, (listener) => {
        fireChange = listener as () => void;
        return { dispose() {} };
      });
      expect(setKeysForSync).toHaveBeenCalledWith(GLOBAL_STATE_SYNC_KEYS);
      expect(GLOBAL_STATE_SYNC_KEYS).toContain(SYNCED_WORKS_KEY);
      expect(refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(STARTUP_REFRESH_DELAY_MS);
      expect(refresh).toHaveBeenCalledTimes(1);
      // 作品の登録・名前の変更のときも読み直す
      fireChange?.();
      vi.advanceTimersByTime(STARTUP_REFRESH_DELAY_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
      disposable.dispose();
      list.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("読み直し", () => {
  test("この機械の作品を足し、別の機械の分は残す。トークンは載らない", async () => {
    const state = memoryState(structuredClone(otherMachine));
    const list = listWith(state, [work("hoshi", "星の海"), work("nogit", "git の無い作品")]);
    await list.refresh();
    expect(state.value).toEqual({
      version: 1,
      works: [
        otherMachine.works[0],
        {
          title: "星の海",
          remoteUrl: "https://github.com/nonahisa/hoshi.git",
          addedAt: "2026-11-17T00:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(state.value)).not.toContain("ghp_secret");
    // 並ぶのはこの機械に無い作品だけ
    expect(list.list().map((row) => row.title)).toEqual(["別の機械の作品"]);
  });

  test("origin を読むまでは並べない（この機械の作品まで一度並ぶのを防ぐ）", () => {
    const list = listWith(memoryState(structuredClone(otherMachine)), []);
    expect(list.list()).toEqual([]);
  });

  test("変わらなければ書かない", async () => {
    const state = memoryState(structuredClone(otherMachine));
    const list = listWith(state, [work("nogit", "git の無い作品")]);
    await list.refresh();
    expect(state.writes).toBe(0);
  });

  test("編集者として参加した作品は載せない", async () => {
    const state = memoryState();
    const list = listWith(state, [work("hoshi", "星の海", { joinedAsEditor: true })]);
    await list.refresh();
    expect(state.writes).toBe(0);
  });

  test("ブラウザ版・編集者モード（enabled が false）では読みも書きもせず、並べない", async () => {
    const state = memoryState(structuredClone(otherMachine));
    const get = vi.spyOn(state, "get");
    const list = listWith(state, [work("hoshi", "星の海")], false);
    await list.refresh();
    expect(list.list()).toEqual([]);
    await list.forget(otherMachine.works[0]);
    expect(state.writes).toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(state.value).toEqual(otherMachine);
  });

  test("壊れた中身は上書きせず、読めなかったことを知らせる", async () => {
    const broken = { version: 1, works: [{ title: "x", remoteUrl: "https://u:t@github.com/o/r", addedAt: "" }] };
    const state = memoryState(structuredClone(broken));
    const reasons: string[] = [];
    const list = listWith(state, [work("hoshi", "星の海")], true, (reason) => reasons.push(reason));
    await list.refresh();
    expect(state.writes).toBe(0);
    expect(state.value).toEqual(broken);
    expect(reasons).toHaveLength(1);
    expect(list.list()).toEqual([]);
  });

  test("新しいバージョンが書いた一覧も上書きしない", async () => {
    const newer = { version: 2, works: [], extra: "新しい項目" };
    const state = memoryState(structuredClone(newer));
    const list = listWith(state, [work("hoshi", "星の海")], true, () => undefined);
    await list.refresh();
    expect(state.value).toEqual(newer);
  });
});

describe("［一覧から外す］", () => {
  test("押した行だけが一覧から消え、描き直しを知らせる", async () => {
    const state = memoryState(structuredClone(otherMachine));
    const list = listWith(state, []);
    await list.refresh();
    const changed = vi.fn();
    list.onDidChange(changed);
    await list.forget(otherMachine.works[0]);
    expect(state.value).toEqual({ version: 1, works: [] });
    expect(changed).toHaveBeenCalled();
    expect(list.list()).toEqual([]);
  });
});
