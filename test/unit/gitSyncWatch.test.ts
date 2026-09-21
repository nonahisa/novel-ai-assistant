import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  fileSystemWatchers,
  resetFileSystemWatchers,
} from "./support/vscodeStub";
import { WorkRegistry } from "../../src/core/workRegistry";
import { affectsSyncStatus, GitSyncMonitor } from "../../src/features/gitSync";
import type { GitCommandResult, GitCommandRunner } from "../../src/core/git";
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

/**
 * 書庫（1つの置き場に複数の作品）でも印が変わるか（設計書6.15.1）。
 *
 * 実機（ノートPC、2026-09-21）で、0.74.1 を入れてもなお「未記録 1」の
 * ままだった。**`dirty` は `git status` が置き場ぜんぶを数えた値**で、
 * 同じ置き場の作品はみな同じ数を持つ。しかも表示側（`gitSyncStatusText.ts`
 * の `uniqueByRoot`）は置き場ごとに**最初の作品の状態だけ**を見る。
 * 末尾の作品だけ作り直しても、表示が見るのは古いままの先頭の作品になる。
 */
describe("書庫の見張り（置き場ごとにまとめて作り直す）", () => {
  const LIBRARY = "C:\\novels\\書庫";
  const WORK_A: WorkEntry = {
    id: "lib-a",
    title: "あかつきの記",
    folderPath: `${LIBRARY}\\あかつきの記`,
    registeredAt: "2026-09-21T00:00:00.000Z",
  };
  const WORK_B: WorkEntry = {
    id: "lib-b",
    title: "たゆたう鉛",
    folderPath: `${LIBRARY}\\たゆたう鉛`,
    registeredAt: "2026-09-21T00:00:00.000Z",
  };

  /**
   * その作品フォルダーを見ている見張りを取り出す。
   *
   * **並び順で選ばない。** 登録簿はタイトル順に並べ替えるので、
   * `fileSystemWatchers[0]` がどの作品かは題名しだいで入れ替わる。
   */
  function watcherFor(folderPath: string) {
    const wanted = folderPath.toLowerCase();
    const found = fileSystemWatchers.find((watcher) => {
      const base = (watcher.pattern as { base?: { fsPath?: string } }).base;
      return (base?.fsPath ?? "").toLowerCase() === wanted;
    });
    if (!found) throw new Error(`見張りが張られていない: ${folderPath}`);
    return found;
  }

  /**
   * 置き場の状態を返すだけの偽git。
   *
   * **どの作品から呼ばれても同じ `git status` を返す**——本物も置き場
   * ぜんぶを数えるので、ここで作品ごとに変えると症状が再現しない。
   */
  function fakeGit(
    state: { porcelain: string },
    rootFor: (cwd: string) => string
  ): { run: GitCommandRunner; calls: Array<{ key: string; cwd: string }> } {
    const calls: Array<{ key: string; cwd: string }> = [];
    const run: GitCommandRunner = async (args, cwd) => {
      const key = args.join(" ");
      calls.push({ key, cwd });
      const reply = (stdout: string): GitCommandResult => ({
        code: 0,
        stdout,
        stderr: "",
      });
      if (key === "rev-parse --is-inside-work-tree") return reply("true\n");
      if (key === "rev-parse --show-toplevel") return reply(`${rootFor(cwd)}\n`);
      if (key === "remote") return reply("origin\n");
      if (key === "symbolic-ref --quiet --short HEAD") return reply("main\n");
      if (key === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
        return reply("origin/main\n");
      }
      if (key.startsWith("rev-list --left-right --count")) return reply("0\t0\n");
      if (key.startsWith("status --porcelain")) return reply(state.porcelain);
      return reply("");
    };
    return { run, calls };
  }

  /** 何件の `git status --porcelain` を、どの作品で走らせたか */
  function statusRuns(
    calls: Array<{ key: string; cwd: string }>,
    folderPath: string
  ): number {
    return calls.filter(
      (call) => call.key === "status --porcelain" && call.cwd === folderPath
    ).length;
  }

  beforeEach(() => {
    resetFileSystemWatchers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("末尾の作品が変わっても、先頭の作品の未記録が増える", async () => {
    const state = { porcelain: " M あかつきの記/001.txt\n" };
    const git = fakeGit(state, () => LIBRARY);
    const registry = new WorkRegistry(fakeContext([WORK_A, WORK_B]) as never);
    const monitor = new GitSyncMonitor(registry, { run: git.run });
    // 起動時と同じように、まず全作品の状態をそろえる
    await monitor.refreshAll({ fetch: false });
    // **表示が見るのは、置き場の中で最初に来る作品の状態**（`uniqueByRoot`）
    const works = registry.list();
    const head = works[0];
    const tail = works[works.length - 1];
    if (!head || !tail || head.id === tail.id) {
      throw new Error("書庫に2作品そろっていない");
    }
    expect(monitor.statusFor(head.id)).toMatchObject({ dirty: 1 });

    // 作者が**末尾の作品**の本文を保存した。置き場の未記録は2件になる
    state.porcelain = " M あかつきの記/001.txt\n M たゆたう鉛/001.txt\n";
    watcherFor(tail.folderPath).fireChange(`${tail.folderPath}\\001.txt`);
    await vi.advanceTimersByTimeAsync(2000);

    // 先頭の作品の状態が古いままだと、画面の数字は変わらない
    expect(monitor.statusFor(head.id)).toMatchObject({ dirty: 2 });
    expect(monitor.statusFor(tail.id)).toMatchObject({ dirty: 2 });
    monitor.dispose();
  });

  test("置き場が別なら、変わった置き場の作品だけ作り直す", async () => {
    const OTHER: WorkEntry = {
      id: "solo",
      title: "ひとりだけの作品",
      folderPath: "C:\\別の場所\\単独作品",
      registeredAt: "2026-09-21T00:00:00.000Z",
    };
    const state = { porcelain: " M 001.txt\n" };
    const git = fakeGit(state, (cwd) =>
      cwd === OTHER.folderPath ? OTHER.folderPath : LIBRARY
    );
    const registry = new WorkRegistry(fakeContext([WORK_A, OTHER]) as never);
    const monitor = new GitSyncMonitor(registry, { run: git.run });
    await monitor.refreshAll({ fetch: false });
    git.calls.length = 0;

    watcherFor(OTHER.folderPath).fireChange(`${OTHER.folderPath}\\001.txt`);
    await vi.advanceTimersByTimeAsync(2000);

    expect(statusRuns(git.calls, OTHER.folderPath)).toBe(1);
    expect(statusRuns(git.calls, WORK_A.folderPath)).toBe(0);
    monitor.dispose();
  });

  test("同じ置き場で続けて保存しても、作り直しは各作品1回ずつ", async () => {
    const state = { porcelain: " M あかつきの記/001.txt\n" };
    const git = fakeGit(state, () => LIBRARY);
    const registry = new WorkRegistry(fakeContext([WORK_A, WORK_B]) as never);
    const monitor = new GitSyncMonitor(registry, { run: git.run });
    await monitor.refreshAll({ fetch: false });
    git.calls.length = 0;

    watcherFor(WORK_A.folderPath).fireChange(`${WORK_A.folderPath}\\001.txt`);
    await vi.advanceTimersByTimeAsync(1000);
    watcherFor(WORK_B.folderPath).fireChange(`${WORK_B.folderPath}\\001.txt`);
    await vi.advanceTimersByTimeAsync(2000);

    // 待ちは置き場ごとに1本なので、まとまって1回ぶんだけ走る
    expect(statusRuns(git.calls, WORK_A.folderPath)).toBe(1);
    expect(statusRuns(git.calls, WORK_B.folderPath)).toBe(1);
    monitor.dispose();
  });
});
