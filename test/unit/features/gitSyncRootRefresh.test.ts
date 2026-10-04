import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GitSyncStatus } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 同じ置き場の作品の控えが、古い数のまま残らないか（設計書6.15.1）。
 *
 * 作者の報告（2026-10-05 01:15）：「変更を記録」のあと git status は0件なのに、
 * ステータスバーは「未記録 9」（novel 2・確認用コピー 7）のまま消えなかった。
 * 同じとき「状態を確認」の知らせは「同期が取れています」と出ていた。
 *
 * 原因：`dirty`・`ahead` などは**置き場ぜんぶの数**なのに、控えは作品ごとに
 * 持っており、操作のあとの数え直しは押した作品1つだけだった。ステータスバーは
 * `isWarning` で絞ってから置き場の先頭を使うので、数え直して0になった作品が
 * 外れ、**古いまま残った兄弟の作品の数**が置き場の代表として出ていた。
 */

const readSyncStatus = vi.fn<(cwd: string) => Promise<GitSyncStatus>>();

vi.mock("../../../src/core/git", async (original) => ({
  ...(await original<typeof import("../../../src/core/git")>()),
  readSyncStatus: (cwd: string) => readSyncStatus(cwd),
  // HEADの入れ替わりの知らせはここでは見ない
  headCommit: async () => undefined,
}));

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
  showLog: vi.fn(),
}));

const { GitSyncMonitor } = await import("../../../src/features/gitSync");
const { fileSystemWatchers, resetFileSystemWatchers } = await import(
  "../support/vscodeStub"
);

const ROOT = "C:/novels/library";
const A: WorkEntry = {
  id: "a",
  title: "作品A",
  folderPath: "C:\\novels\\library\\a",
  registeredAt: "2026-10-05T00:00:00.000Z",
};
const B: WorkEntry = {
  id: "b",
  title: "作品B",
  folderPath: "C:\\novels\\library\\b",
  registeredAt: "2026-10-05T00:00:00.000Z",
};

function tracked(dirty: number, dirtyHere: number): GitSyncStatus {
  return {
    kind: "tracked",
    root: ROOT,
    branch: "main",
    upstream: "origin/main",
    behind: 0,
    ahead: 0,
    behindHere: 0,
    aheadHere: 0,
    dirty,
    dirtyHere,
    unmerged: 0,
  };
}

const registry = {
  list: () => [A, B],
  get: (id: string) => [A, B].find((work) => work.id === id),
  onDidChange: () => ({ dispose: () => undefined }),
};

/** ステータスバーの文字（非公開なので覗く。出す・隠すも見る） */
function statusBarOf(monitor: InstanceType<typeof GitSyncMonitor>): {
  text: string;
  visible: boolean;
} {
  const bar = (monitor as unknown as { statusBar: { text: string } }).statusBar;
  return { text: bar.text, visible: visibleBars.has(bar) };
}

/** `show()`／`hide()` を覚える（スタブはどちらも何もしない） */
const visibleBars = new Set<object>();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function newMonitor(): InstanceType<typeof GitSyncMonitor> {
  const monitor = new GitSyncMonitor(registry as never);
  const bar = (monitor as unknown as {
    statusBar: { show(): void; hide(): void };
  }).statusBar;
  bar.show = () => visibleBars.add(bar);
  bar.hide = () => visibleBars.delete(bar);
  return monitor;
}

beforeEach(() => {
  readSyncStatus.mockReset();
  visibleBars.clear();
  resetFileSystemWatchers();
});

describe("1作品を数え直したら、同じ置き場の作品の控えも揃う", () => {
  test("記録のあと押した作品だけ数え直しても、兄弟の未記録が残らない（作者の報告の再現）", async () => {
    const monitor = newMonitor();
    // 記録の前：置き場ぜんぶで7件（Aに3件、Bに4件）
    readSyncStatus.mockImplementation(async (cwd) =>
      cwd === A.folderPath ? tracked(7, 3) : tracked(7, 4)
    );
    await monitor.refreshAll({ fetch: false });
    expect(statusBarOf(monitor).text).toContain("未記録 7");

    // 記録した。git の上では0件
    readSyncStatus.mockImplementation(async () => tracked(0, 0));
    // 操作のあとに数え直すのは、押した作品1つ（「状態を確認」も同じ）
    await monitor.refresh(B, { fetch: false, notify: false });

    const a = monitor.statusFor(A.id);
    expect(a?.kind === "tracked" && a.dirty).toBe(0);
    // 置き場ぜんぶが0なら、その作品のぶんも0しかありえない
    expect(a?.kind === "tracked" && a.dirtyHere).toBe(0);
    expect(statusBarOf(monitor).visible).toBe(false);
    monitor.dispose();
  });

  test("置き場ぜんぶの数が減っても、作品のぶんがそれを超えて残らない", async () => {
    const monitor = newMonitor();
    readSyncStatus.mockImplementation(async (cwd) =>
      cwd === A.folderPath ? tracked(9, 6) : tracked(9, 3)
    );
    await monitor.refreshAll({ fetch: false });

    // Bの3件だけ記録した。残りはAの2件
    readSyncStatus.mockImplementation(async () => tracked(2, 0));
    await monitor.refresh(B, { fetch: false, notify: false });

    const a = monitor.statusFor(A.id);
    expect(a?.kind === "tracked" && a.dirty).toBe(2);
    expect(a?.kind === "tracked" && a.dirtyHere).toBe(2);
    expect(statusBarOf(monitor).text).toContain("未記録 2");
    monitor.dispose();
  });
});

describe("古い数え直しが、新しい結果を上書きしない", () => {
  test("記録の途中で始まった数え直しが、記録のあとの数え直しより遅れて返っても捨てる", async () => {
    const monitor = newMonitor();
    readSyncStatus.mockImplementation(async () => tracked(0, 0));
    await monitor.refreshAll({ fetch: false });

    // 記録の途中で見張りが数え直しを始めた（まだ8件残っている）
    const midway = deferred<GitSyncStatus>();
    readSyncStatus.mockImplementationOnce(() => midway.promise);
    const stale = monitor.refresh(A, { fetch: false, notify: false });

    // 記録が終わり、操作の終わりの数え直しが先に返る（0件）
    readSyncStatus.mockImplementation(async () => tracked(0, 0));
    await monitor.refresh(A, { fetch: false, notify: false });

    // 途中の読みが、あとから返ってくる
    midway.resolve(tracked(8, 8));
    await stale;

    const a = monitor.statusFor(A.id);
    expect(a?.kind === "tracked" && a.dirty).toBe(0);
    expect(statusBarOf(monitor).visible).toBe(false);
    monitor.dispose();
  });

  test("兄弟の作品の新しい読みより古い読みも捨てる", async () => {
    const monitor = newMonitor();
    readSyncStatus.mockImplementation(async () => tracked(0, 0));
    await monitor.refreshAll({ fetch: false });

    const midway = deferred<GitSyncStatus>();
    readSyncStatus.mockImplementationOnce(() => midway.promise);
    const stale = monitor.refresh(A, { fetch: false, notify: false });

    readSyncStatus.mockImplementation(async () => tracked(0, 0));
    await monitor.refresh(B, { fetch: false, notify: false });

    midway.resolve(tracked(5, 5));
    await stale;

    expect(statusBarOf(monitor).visible).toBe(false);
    monitor.dispose();
  });
});

describe("操作の終わりは置き場ぜんぶを数え直す", () => {
  test("refreshRoot は同じ置き場の作品をみな読み直す", async () => {
    const monitor = newMonitor();
    readSyncStatus.mockImplementation(async (cwd) =>
      cwd === A.folderPath ? tracked(5, 1) : tracked(5, 4)
    );
    await monitor.refreshAll({ fetch: false });

    readSyncStatus.mockClear();
    readSyncStatus.mockImplementation(async (cwd) =>
      cwd === A.folderPath ? tracked(3, 3) : tracked(3, 0)
    );
    await monitor.refreshRoot(A, { fetch: false, notify: false });

    const called = readSyncStatus.mock.calls.map(([cwd]) => cwd).sort();
    expect(called).toEqual([A.folderPath, B.folderPath].sort());
    const b = monitor.statusFor(B.id);
    expect(b?.kind === "tracked" && b.dirtyHere).toBe(0);
    const a = monitor.statusFor(A.id);
    expect(a?.kind === "tracked" && a.dirtyHere).toBe(3);
    monitor.dispose();
  });
});

describe("git の操作の最中は、見張りの数え直しを待たせる", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("記録の最中に保存の合図が来ても、終わるまで数え直さない", async () => {
    const monitor = newMonitor();
    const watcher = fileSystemWatchers[0];
    if (!watcher) throw new Error("見張りが張られていない");
    readSyncStatus.mockImplementation(async () => tracked(1, 1));

    const gate = deferred<void>();
    const operation = monitor.whileOperating(() => gate.promise);

    watcher.fireChange("C:\\novels\\library\\a\\第1話.txt");
    await vi.advanceTimersByTimeAsync(2500);
    expect(readSyncStatus).not.toHaveBeenCalled();

    gate.resolve();
    await operation;
    await vi.advanceTimersByTimeAsync(2500);
    expect(readSyncStatus).toHaveBeenCalled();
    monitor.dispose();
  });
});
