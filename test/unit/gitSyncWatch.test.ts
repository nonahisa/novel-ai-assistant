import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  fileSystemWatchers,
  resetFileSystemWatchers,
} from "./support/vscodeStub";
import { WorkRegistry } from "../../src/core/workRegistry";
import { affectsSyncStatus, GitSyncMonitor } from "../../src/features/gitSync";
import type { WorkEntry } from "../../src/models/types";

/**
 * 保存しただけで「送っていないもの」の印が変わるか（設計書6.15.1）。
 *
 * 実機（ノートPC、2026-09-21）で、1文字書いて保存しても「未記録 N」が
 * 増えなかった。印を作り直す契機が**起動時・同期の操作のあと・エディタの
 * 切り替え**しか無く、自前の原稿エディタ（WebView。保存は
 * `workspace.fs.writeFile`）ではそのどれも飛ばなかったため。
 *
 * ここで見るのは、**作品フォルダーの見張りが正しい契機になっているか**だけ。
 * gitの読み取りそのものは `refresh` の中なので、呼ばれたことで足りる。
 */

/** 登録簿の中身を持つだけの `globalState`（`renameWork.test.ts` と同じ形） */
function fakeContext(works: WorkEntry[]): { globalState: unknown } {
  let stored = works;
  return {
    globalState: {
      get: <T>(_key: string, _defaultValue: T): T => stored as unknown as T,
      update: async (_key: string, value: unknown) => {
        stored = value as WorkEntry[];
      },
    },
  };
}

const WORK: WorkEntry = {
  id: "w1",
  title: "テスト作品",
  folderPath: "C:\\novels\\w1",
  registeredAt: "2026-09-21T00:00:00.000Z",
};

/** 見張りと、呼ばれた `refresh` を覗ける形で1組そろえる */
function setup(): {
  monitor: GitSyncMonitor;
  refresh: ReturnType<typeof vi.fn>;
  watcher: (typeof fileSystemWatchers)[number];
} {
  const registry = new WorkRegistry(fakeContext([WORK]) as never);
  const monitor = new GitSyncMonitor(registry);
  // **実際にgitを走らせない。** ここで確かめたいのは契機であって、
  // どんな状態が読めるかではない
  const refresh = vi.fn(async () => ({ kind: "not_a_repo" }) as never);
  monitor.refresh = refresh as unknown as GitSyncMonitor["refresh"];
  const watcher = fileSystemWatchers[0];
  if (!watcher) throw new Error("作品フォルダーの見張りが張られていない");
  return { monitor, refresh, watcher };
}

describe("作品フォルダーの見張り（未送信の常時表示の契機）", () => {
  beforeEach(() => {
    resetFileSystemWatchers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("登録されている作品ごとに見張りを張る", () => {
    setup();
    expect(fileSystemWatchers).toHaveLength(1);
  });

  test("本文を保存すると、2秒後に1回だけ作り直す（取りに行かず・知らせず）", () => {
    const { monitor, refresh, watcher } = setup();

    watcher.fireChange("C:\\novels\\w1\\第1話.txt");
    // 待っている間は走らない（続けて保存されるのが普通なので、まとめる）
    vi.advanceTimersByTime(1000);
    expect(refresh).not.toHaveBeenCalled();
    watcher.fireChange("C:\\novels\\w1\\第2話.txt");
    vi.advanceTimersByTime(2000);

    expect(refresh).toHaveBeenCalledTimes(1);
    // **ネットへは出ない。知らせも出さない。** 印が変わるだけ
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1" }),
      { fetch: false, notify: false }
    );
    monitor.dispose();
  });

  test("記録・統計・gitの中の書き換えでは作り直さない", () => {
    const { monitor, refresh, watcher } = setup();

    // ここで回すと、作り直しが自分でログを書いて自分を起こし続ける
    watcher.fireChange("C:\\novels\\w1\\.aiwriter\\logs\\2026-09-21.log");
    watcher.fireChange("C:\\novels\\w1\\.aiwriter\\stats\\2026-09.json");
    watcher.fireChange("C:\\novels\\w1\\.git\\index");
    vi.advanceTimersByTime(5000);

    expect(refresh).not.toHaveBeenCalled();
    monitor.dispose();
  });

  test("dispose すると見張りも待ちも止まる", () => {
    const { monitor, refresh, watcher } = setup();

    watcher.fireChange("C:\\novels\\w1\\第1話.txt");
    monitor.dispose();
    vi.advanceTimersByTime(5000);

    expect(refresh).not.toHaveBeenCalled();
    expect(watcher.disposed).toBe(true);
  });
});

describe("その変化で送信待ちの数が変わりうるか", () => {
  test("原稿と設定資料は数える", () => {
    expect(affectsSyncStatus("C:\\novels\\w1\\第1話.txt")).toBe(true);
    expect(affectsSyncStatus("C:\\novels\\w1\\設定\\人物.json")).toBe(true);
  });

  test("記録・統計・gitの中は数えない", () => {
    expect(affectsSyncStatus("C:\\novels\\w1\\.git\\index")).toBe(false);
    expect(affectsSyncStatus("/novels/w1/.aiwriter/logs/a.log")).toBe(false);
    expect(affectsSyncStatus("/novels/w1/.aiwriter/stats/a.json")).toBe(false);
  });

  test("キャッシュや承認待ちは数える（見張りの対象は絞りすぎない）", () => {
    // 同期から外してあるものでも、数え直しは `git status` に任せる。
    // ここで先回りして外すと、外し忘れた所が黙って効かなくなる
    expect(affectsSyncStatus("/novels/w1/.aiwriter/cache/a.json")).toBe(true);
  });
});
