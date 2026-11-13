import { beforeEach, describe, expect, test, vi } from "vitest";

// 作品のフォルダーは在るものとして扱う（作り物の道はディスクに無い）。無いときの決まりは
// `handoffStartupMissingWork.test.ts` が見る（2026-11-14）
vi.mock("../../../src/core/workFolderPresence", () => ({
  isWorkFolderPresent: async () => true,
  findMissingWorks: async () => [],
}));

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  useLogFile: vi.fn(),
  useLogFiles: vi.fn(),
  showLog: vi.fn(),
}));

import { runStartupHandoff } from "../../../src/features/handoffSync";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import { window } from "../support/vscodeStub";

/**
 * 開いたときの点検が、置き場1つあたりで git を何本起こすか（2026-11-05）。
 *
 * 速さの正体は git の起動回数（作者のノートPCで1回約148ms）なので、回数を数えて固める。
 * あわせて、数を減らしても **点検の結果（知らせ）と、点検のあとに作り直す対象は
 * 直す前と同じ** であることを、送る・取り込む・何もない・リポジトリでない、の
 * 4つの形で見張る。
 */

const ROOT = "C:/置き場";
const works = [
  { id: "w0", title: "作品0", folderPath: `${ROOT}/作品0` },
  { id: "w1", title: "作品1", folderPath: `${ROOT}/作品1` },
];
const outside = [{ id: "o0", title: "外", folderPath: "C:/外/作品" }];

interface Scenario {
  ahead: number;
  /** fetch のあとに見える遅れ */
  behindAfterFetch: number;
}

/** 偽の git。置き場の状態を持ち、fetch／pull／push で動く */
function makeGit(scenario: Scenario) {
  const calls: string[] = [];
  let behind = 0;
  let ahead = scenario.ahead;
  const runner: GitCommandRunner = async (args, cwd) => {
    const joined = args.join(" ");
    calls.push(joined);
    const inside = cwd.startsWith(ROOT);
    if (args[0] === "--version") return { code: 0, stdout: "git version 2.55.0", stderr: "" };
    if (!inside) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: ROOT, stderr: "" };
    if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
      return { code: 0, stdout: `true\n${ROOT}`, stderr: "" };
    }
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
    if (joined.startsWith("rev-parse --abbrev-ref")) {
      return { code: 0, stdout: "origin/main", stderr: "" };
    }
    if (args[0] === "rev-list") return { code: 0, stdout: `${behind}\t${ahead}`, stderr: "" };
    if (args[0] === "fetch") {
      behind = scenario.behindAfterFetch;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "pull") {
      behind = 0;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "push") {
      ahead = 0;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

let shown: string[];

beforeEach(() => {
  shown = [];
  Object.assign(window, {
    showWarningMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
  });
});

/**
 * 見張りの代役。作り直された作品（`refreshAll` なら全部、`refreshRoot` ならその作品と
 * 同じ置き場の作品）を控える。`prior` は、点検の前に見張りが持っていた状態
 */
function makeMonitor(
  list: typeof works,
  prior: (workId: string) => GitSyncStatus | undefined = () => undefined
) {
  const refreshed = new Set<string>();
  const monitor = {
    refreshAll: async () => {
      for (const work of list) refreshed.add(work.id);
    },
    refreshRoot: async (work: { id: string }) => {
      const mine = list.find((one) => one.id === work.id);
      for (const one of list) {
        if (mine && one.folderPath.startsWith(ROOT) === mine.folderPath.startsWith(ROOT)) {
          refreshed.add(one.id);
        }
      }
      return { kind: "not_a_repo" } as GitSyncStatus;
    },
    refresh: async (work: { id: string }) => {
      refreshed.add(work.id);
      return { kind: "not_a_repo" } as GitSyncStatus;
    },
    statusFor: prior,
  };
  return { monitor, refreshed };
}

function deps(list: typeof works, runner: GitCommandRunner, monitor: unknown) {
  const store: Record<string, unknown> = {};
  return {
    registry: { list: () => list } as never,
    monitor: monitor as never,
    storage: {
      get: <T>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => {
        store[key] = value;
      },
    },
    run: runner,
  };
}

describe("開いたときの点検：結果は変えずに git の本数を数える", () => {
  test("送るものがある：送って、全作品を作り直す", async () => {
    const { runner, calls } = makeGit({ ahead: 2, behindAfterFetch: 0 });
    const { monitor, refreshed } = makeMonitor(works);
    await runStartupHandoff(deps(works, runner, monitor));
    expect(shown.join("\n")).toContain("送信 1か所");
    expect([...refreshed].sort()).toEqual(["w0", "w1"]);
    expect(calls.filter((c) => c === "push")).toHaveLength(1);
    // 直す前は 18 本（根の確かめの重ね＋fetch のあとの丸ごと読み直し）
    expect(calls).toHaveLength(13);
  });

  test("取り込むものがある：取り込んで、全作品を作り直す", async () => {
    const { runner, calls } = makeGit({ ahead: 0, behindAfterFetch: 3 });
    const { monitor, refreshed } = makeMonitor(works);
    await runStartupHandoff(deps(works, runner, monitor));
    expect(shown.join("\n")).toContain("取り込み 1か所");
    expect([...refreshed].sort()).toEqual(["w0", "w1"]);
    expect(calls.filter((c) => c === "pull --ff-only")).toHaveLength(1);
    // 直す前は 24 本。取り込み前の未記録の確認（`pullFastForward` の丸ごと読み）6 本は安全のために残す
    expect(calls).toHaveLength(19);
  });

  test("何もない：知らせなし。見張りが同じ状態を持っていなければ作り直す", async () => {
    const { runner, calls } = makeGit({ ahead: 0, behindAfterFetch: 0 });
    const { monitor, refreshed } = makeMonitor(works);
    await runStartupHandoff(deps(works, runner, monitor));
    expect(shown).toEqual([]);
    expect([...refreshed].sort()).toEqual(["w0", "w1"]);
    // 直す前は 17 本。根の確かめ2（作品ごと）＋最初の読み7＋fetch1＋読み直し2
    expect(calls).toHaveLength(12);
    expect(calls.filter((c) => c.startsWith("remote"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("symbolic-ref"))).toHaveLength(1);
  });

  test("リポジトリでない：知らせなし。作り直す", async () => {
    const { runner, calls } = makeGit({ ahead: 0, behindAfterFetch: 0 });
    const { monitor, refreshed } = makeMonitor(outside);
    await runStartupHandoff(deps(outside, runner, monitor));
    expect(shown).toEqual([]);
    expect([...refreshed]).toEqual(["o0"]);
    expect(calls).toHaveLength(3);
  });
});

describe("開いたときの点検：見張りが同じ状態を持っている置き場は作り直さない", () => {
  const same: GitSyncStatus = {
    kind: "tracked",
    root: ROOT,
    branch: "main",
    upstream: "origin/main",
    behind: 0,
    ahead: 0,
    behindHere: 0,
    aheadHere: 0,
    dirty: 0,
    dirtyHere: 0,
    unmerged: 0,
  };

  test("何もしなかった置き場で、見張りの状態が同じなら読み直さない", async () => {
    const { runner } = makeGit({ ahead: 0, behindAfterFetch: 0 });
    const { monitor, refreshed } = makeMonitor(works, () => same);
    await runStartupHandoff(deps(works, runner, monitor));
    expect(shown).toEqual([]);
    expect([...refreshed]).toEqual([]);
  });

  test("見張りの状態が違えば（送り残しの数など）読み直す", async () => {
    const { runner } = makeGit({ ahead: 0, behindAfterFetch: 0 });
    const { monitor, refreshed } = makeMonitor(works, () => ({ ...same, dirty: 2 }));
    await runStartupHandoff(deps(works, runner, monitor));
    expect([...refreshed].sort()).toEqual(["w0", "w1"]);
  });

  test("置き場の作品のうち1つでも見張りが状態を持っていなければ読み直す", async () => {
    const { runner } = makeGit({ ahead: 0, behindAfterFetch: 0 });
    const { monitor, refreshed } = makeMonitor(works, (id) => (id === "w0" ? same : undefined));
    await runStartupHandoff(deps(works, runner, monitor));
    expect([...refreshed].sort()).toEqual(["w0", "w1"]);
  });

  test("動かした置き場（送った）は、見張りが同じ状態でも読み直す", async () => {
    const { runner } = makeGit({ ahead: 2, behindAfterFetch: 0 });
    const { monitor, refreshed } = makeMonitor(works, () => ({ ...same, ahead: 2 }));
    await runStartupHandoff(deps(works, runner, monitor));
    expect([...refreshed].sort()).toEqual(["w0", "w1"]);
  });

  test("見張りが refreshRoot を持たなければ、これまでどおり全部作り直す", async () => {
    const { runner } = makeGit({ ahead: 0, behindAfterFetch: 0 });
    const { monitor, refreshed } = makeMonitor(works, () => same);
    const bare = { ...monitor, refreshRoot: undefined };
    await runStartupHandoff(deps(works, runner, bare));
    expect([...refreshed].sort()).toEqual(["w0", "w1"]);
  });
});
