import { beforeEach, describe, expect, test, vi } from "vitest";

// 作品のフォルダーは在るものとして扱う（作り物の道はディスクに無い）
vi.mock("../../../src/core/workFolderPresence", () => ({
  isWorkFolderPresent: async () => true,
  findMissingWorks: async () => [],
}));

const logged = vi.hoisted(() => ({ failures: [] as Array<Record<string, string>> }));

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn((_title: string, fields: Record<string, string>) => {
    logged.failures.push(fields);
  }),
  logStep: vi.fn(),
  useLogFile: vi.fn(),
  useLogFiles: vi.fn(),
  showLog: vi.fn(),
}));

import { runStartupHandoff } from "../../../src/features/handoffSync";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import { window } from "../support/vscodeStub";

/**
 * 開いたときの点検で、**置き場ごとの fetch を同時に走らせる**（設計書6.15.1）。
 *
 * 置き場を1つずつ取りに行っていたので、中央13秒・最大20秒かかっていた。
 *
 * 見張ること：
 * - 置き場が3つなら、fetch は3つとも同時に走る（1つずつ待たない）
 * - fetch のあとの動き（記録の行を含む）は**置き場の順**のまま。後ろの置き場の
 *   fetch が先に終わっても、記録は前の置き場から並ぶ
 */

const ROOTS = ["C:/置き場A", "C:/置き場B", "C:/置き場C"];
const works = ROOTS.map((root, index) => ({
  id: `w${index}`,
  title: `作品${index}`,
  folderPath: `${root}/作品`,
}));

/** fetch の早さ（ミリ秒）。先頭ほど遅い */
const FETCH_MS: Record<string, number> = {
  "C:/置き場A": 40,
  "C:/置き場B": 20,
  "C:/置き場C": 5,
};

function makeGit() {
  let fetching = 0;
  let maxFetching = 0;
  const fetchEnded: string[] = [];
  const runner: GitCommandRunner = async (args, cwd) => {
    const joined = args.join(" ");
    const root = ROOTS.find((one) => cwd.startsWith(one));
    if (args[0] === "--version") return { code: 0, stdout: "git version 2.55.0", stderr: "" };
    if (!root) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: root, stderr: "" };
    if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
      return { code: 0, stdout: `true\n${root}`, stderr: "" };
    }
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
    if (joined.startsWith("rev-parse --abbrev-ref")) {
      return { code: 0, stdout: "origin/main", stderr: "" };
    }
    if (args[0] === "rev-list") return { code: 0, stdout: "0\t0", stderr: "" };
    if (args[0] === "fetch") {
      fetching++;
      maxFetching = Math.max(maxFetching, fetching);
      await new Promise((r) => setTimeout(r, FETCH_MS[root]));
      fetching--;
      fetchEnded.push(root);
      // 取りに行けなかった形（オフライン）。記録の行の並びを見るため
      return { code: 128, stdout: "", stderr: `fatal: ${root} に届きません` };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, maxFetching: () => maxFetching, fetchEnded };
}

function deps(runner: GitCommandRunner) {
  const store: Record<string, unknown> = {};
  return {
    registry: { list: () => works } as never,
    monitor: {
      refreshAll: async () => undefined,
      refresh: async () => ({ kind: "not_a_repo" }) as GitSyncStatus,
      statusFor: () => undefined,
    } as never,
    storage: {
      get: <T>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => {
        store[key] = value;
      },
    },
    run: runner,
  };
}

beforeEach(() => {
  logged.failures = [];
  Object.assign(window, {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  });
});

describe("置き場ごとの fetch を同時に走らせる", () => {
  test("3つの置き場の fetch が同時に走る", async () => {
    const git = makeGit();
    await runStartupHandoff(deps(git.runner));
    expect(git.maxFetching()).toBe(3);
    // 早いものから終わっている（＝待ち合わせずに同時に走った）
    expect(git.fetchEnded).toEqual(["C:/置き場C", "C:/置き場B", "C:/置き場A"]);
  });

  test("後ろの置き場が先に終わっても、記録の行は置き場の順に並ぶ", async () => {
    const git = makeGit();
    await runStartupHandoff(deps(git.runner));
    const fetchFailures = logged.failures.filter((fields) =>
      (fields.詳細 ?? "").includes("に届きません")
    );
    expect(fetchFailures.map((fields) => fields.置き場)).toHaveLength(3);
    expect(fetchFailures.map((fields) => fields.詳細)).toEqual(
      ROOTS.map((root) => expect.stringContaining(root))
    );
  });
});
