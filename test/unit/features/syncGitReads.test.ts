import { beforeEach, describe, expect, test } from "vitest";
import { syncAllWorks } from "../../../src/features/syncAllWorks";
import { runStartupHandoff } from "../../../src/features/handoffSync";
import { GitSyncMonitor } from "../../../src/features/gitSync";
import { WorkRegistry } from "../../../src/core/workRegistry";
import type { GitCommandResult, GitCommandRunner } from "../../../src/core/git";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { resetFileSystemWatchers, window, workspace } from "../support/vscodeStub";

/**
 * 同期前のチェックで、**同じ置き場を作品の数だけ読み直さない**
 * （docs/measurements/2026-10-29-非AIの速さ.md）。
 *
 * 写し（7作品・置き場1つ）で「全作品同期」の確認の窓まで git 73回・1.3秒
 * かかっていた。待ちのほぼ全部が git の起動で、
 *
 * - 「作品をすべて同期」（`collectStates`）と開いたときの点検（`collectTargets`）は、
 *   作品ごとに状態を全部読んでから「同じ置き場はもう見た」と飛ばしていた
 * - 見張りの `refreshAll` は、置き場ぜんぶの数を作品の数だけ読み直していた
 *
 * ここでは**置き場ぜんぶを読む命令の回数**で確かめる（作品ごとに要る
 * 「その作品の中だけ」の読みは減らさない）。
 */

const LIBRARY = "C:/書庫";

/** 同じ置き場（書庫）に入っている3作品 */
const threeWorks: WorkEntry[] = [
  { id: "w1", title: "あかつきの記", folderPath: `${LIBRARY}/あかつきの記`, registeredAt: "2026-10-29T00:00:00.000Z" },
  { id: "w2", title: "たゆたう鉛", folderPath: `${LIBRARY}/たゆたう鉛`, registeredAt: "2026-10-29T00:00:00.000Z" },
  { id: "w3", title: "みずうみの底", folderPath: `${LIBRARY}/みずうみの底`, registeredAt: "2026-10-29T00:00:00.000Z" },
] as WorkEntry[];

/** 呼ばれた git（引数を空白でつないだ形） */
let calls: string[] = [];

/**
 * 書庫1つぶんの作り物の git。きれいで、遅れも先行も無い置き場。
 * `state.porcelain` を書き換えると、置き場ぜんぶの `git status` が変わる。
 */
function libraryGit(
  state: { porcelain: string; onCall?: (key: string) => Promise<void> } = { porcelain: "" }
): GitCommandRunner {
  return async (args) => {
    const key = args.join(" ");
    calls.push(key);
    await state.onCall?.(key);
    const ok = (stdout = ""): GitCommandResult => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "--version") return ok("git version 2.55");
    if (key === "rev-parse --is-inside-work-tree --show-toplevel") return ok(`true\n${LIBRARY}\n`);
    if (key === "rev-parse --show-toplevel") return ok(`${LIBRARY}\n`);
    // 根の確かめを2回に分けていたころの呼び方にも答える（直す前に落ちる形を見るため）
    if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
    if (key === "status --porcelain") return ok(state.porcelain);
    if (args[0] === "status") return ok("");
    if (key === "remote") return ok("origin\n");
    if (args[0] === "symbolic-ref") return ok("main\n");
    if (key.startsWith("rev-parse --abbrev-ref")) return ok("origin/main\n");
    if (args[0] === "rev-list") return ok("0\t0\n");
    return ok("");
  };
}

/** 置き場ぜんぶを読む命令（作品の中だけの `-- .` は含めない） */
function wholeRepoReads(list: readonly string[]): number {
  return list.filter(
    (key) =>
      key === "status --porcelain" ||
      key === "remote" ||
      key === "symbolic-ref --quiet --short HEAD" ||
      key === "rev-list --left-right --count origin/main...HEAD"
  ).length;
}

/** 最初の fetch より前に呼ばれた git（取り寄せの前の「状態を集める」段） */
function beforeFirstFetch(): string[] {
  const at = calls.findIndex((key) => key.startsWith("fetch"));
  return at < 0 ? [...calls] : calls.slice(0, at);
}

beforeEach(() => {
  calls = [];
  resetFileSystemWatchers();
  workspace.textDocuments = [];
  Object.assign(window, {
    withProgress: (
      _options: unknown,
      task: (
        progress: { report(value: { message?: string }): void },
        token: { isCancellationRequested: boolean }
      ) => unknown
    ) => Promise.resolve(task({ report: () => {} }, { isCancellationRequested: false })),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  });
});

describe("作品をすべて同期：状態を集める段（collectStates）", () => {
  test("同じ置き場の3作品でも、置き場の状態は1回だけ読む", async () => {
    const registry = { list: () => threeWorks } as unknown as WorkRegistry;
    const monitor = { refreshAll: async () => {} } as unknown as GitSyncMonitorLike;

    // 確認の窓は閉じる（作り物の showInformationMessage は何も選ばない）。
    // ここまでに呼ばれた git が、状態を集める段のすべてである
    await syncAllWorks({ registry, monitor, run: libraryGit() });

    // 根は作品ごとに調べる（どの置き場に入っているかで分けるため）
    expect(calls.filter((key) => key === "rev-parse --show-toplevel")).toHaveLength(3);
    // 置き場ぜんぶの読みは、取り寄せの前の1回と後の1回（4命令ずつ）だけ
    expect(wholeRepoReads(calls)).toBe(8);
    // 取り寄せは置き場ごとに1回
    expect(calls.filter((key) => key.startsWith("fetch"))).toHaveLength(1);
  });
});

describe("開いたときの点検：置き場を集める段（collectTargets）", () => {
  test("同じ置き場の3作品でも、置き場の状態は1回だけ読む", async () => {
    const registry = { list: () => threeWorks } as unknown as WorkRegistry;
    const monitor = {
      refreshAll: async () => {},
      statusFor: () => undefined,
    } as unknown as GitSyncMonitorLike;
    const store: Record<string, unknown> = {};

    await runStartupHandoff({
      registry,
      monitor,
      storage: {
        get: <T>(key: string) => store[key] as T | undefined,
        update: async (key: string, value: unknown) => {
          store[key] = value;
        },
      },
      run: libraryGit(),
    });

    const before = beforeFirstFetch();
    expect(before.filter((key) => key === "rev-parse --show-toplevel")).toHaveLength(3);
    expect(wholeRepoReads(before)).toBe(4);
    expect(calls.filter((key) => key.startsWith("fetch"))).toHaveLength(1);
  });
});

/** 登録簿の中身を持つだけの `globalState`（`gitSyncWatch.test.ts` と同じ形） */
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

describe("見張りの作り直し（GitSyncMonitor.refreshAll）", () => {
  test("同じ置き場の3作品でも、置き場ぜんぶの数は1回だけ読む", async () => {
    const registry = new WorkRegistry(fakeContext(threeWorks) as never);
    const monitor = new GitSyncMonitor(registry, {
      run: libraryGit({ porcelain: " M あかつきの記/001.txt\n" }),
    });

    await monitor.refreshAll({ fetch: false });

    expect(calls.filter((key) => key === "status --porcelain")).toHaveLength(1);
    expect(calls.filter((key) => key === "remote")).toHaveLength(1);
    // その作品の中だけの数は、作品ごとに読む
    expect(calls.filter((key) => key === "status --porcelain -- .")).toHaveLength(3);
    // どの作品にも、置き場ぜんぶの数が入っている
    for (const work of threeWorks) {
      expect(monitor.statusFor(work.id)).toMatchObject({ kind: "tracked", dirty: 1 });
    }
    monitor.dispose();
  });

  test("一巡の途中で別の読みが割り込んでも、使い回した古い数で上書きしない", async () => {
    // 2026-10-05「未記録9がふえました」と同じ形の危険。一巡の最初に読んだ
    // 置き場ぜんぶの数を後の作品へ使い回すので、途中で記録が済んで別の読みが
    // 新しい数を入れたら、使い回した古い数が勝ってはいけない
    const state: { porcelain: string; onCall?: (key: string) => Promise<void> } = {
      porcelain: " M あかつきの記/001.txt\n",
    };
    const registry = new WorkRegistry(fakeContext(threeWorks) as never);
    const monitor = new GitSyncMonitor(registry, { run: libraryGit(state) });
    const works = registry.list();
    const first = works[0];
    if (!first) throw new Error("作品がそろっていない");

    let interrupted = false;
    let perWorkReads = 0;
    state.onCall = async (key) => {
      if (key !== "status --porcelain -- .") return;
      perWorkReads += 1;
      // 2作品目を読んでいる最中に、置き場の変更が2件に増え、
      // 見張り（使い回しなし）が先頭の作品を読み直した
      if (perWorkReads === 2 && !interrupted) {
        interrupted = true;
        state.porcelain = " M あかつきの記/001.txt\n M たゆたう鉛/001.txt\n";
        await monitor.refresh(first, { fetch: false, notify: false });
      }
    };

    await monitor.refreshAll({ fetch: false });

    expect(interrupted).toBe(true);
    for (const work of works) {
      expect(monitor.statusFor(work.id), work.title).toMatchObject({ dirty: 2 });
    }
    monitor.dispose();
  });
});
