import { beforeEach, describe, expect, test } from "vitest";
import { syncAllWorks } from "../../../src/features/syncAllWorks";
import type { GitCommandRunner } from "../../../src/core/git";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { window } from "../support/vscodeStub";

/**
 * 確認の窓が出るまでに、置き場1つあたりで git を何回起こすか（2026-11-05）。
 *
 * 速さの正体は git の起動回数（ノートPCで1回約148ms）なので、回数を数えて
 * 固める。あわせて、fetch で behind が増えたことが窓に届くことも見る
 * （読み直しを減らしても、窓に渡る状態は変わらない）。
 */

const work = { id: "w0", title: "作品0", folderPath: "C:/置き場/作品0" } as WorkEntry;
const registry = { list: () => [work] } as unknown as WorkRegistry;
const monitor = { refreshAll: async () => {} } as unknown as GitSyncMonitorLike;

let calls: string[][] = [];
let fetched = false;
let shown: string[] = [];

const runner: GitCommandRunner = async (args) => {
  calls.push(args);
  const joined = args.join(" ");
  if (args[0] === "fetch") {
    fetched = true;
    return { code: 0, stdout: "", stderr: "" };
  }
  if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: "C:/置き場", stderr: "" };
  if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
    return { code: 0, stdout: "true\nC:/置き場", stderr: "" };
  }
  if (joined === "status --porcelain --untracked-files=all") {
    return { code: 0, stdout: " M 本文/1.txt\n", stderr: "" };
  }
  if (args[0] === "status") return { code: 0, stdout: " M 本文/1.txt\n", stderr: "" };
  if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
  if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
  if (joined.startsWith("rev-parse --abbrev-ref")) {
    return { code: 0, stdout: "origin/main", stderr: "" };
  }
  if (args[0] === "rev-list") {
    // fetch の前は遅れ 0、あとは遅れ 4
    return { code: 0, stdout: fetched ? "4\t0" : "0\t0", stderr: "" };
  }
  if (args[0] === "config") return { code: 0, stdout: "作者", stderr: "" };
  if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

beforeEach(() => {
  calls = [];
  fetched = false;
  shown = [];
  Object.assign(window, {
    withProgress: (
      _options: unknown,
      task: (
        progress: { report(value: { message?: string }): void },
        token: { isCancellationRequested: boolean }
      ) => unknown
    ) =>
      Promise.resolve(task({ report: () => {} }, { isCancellationRequested: false })),
    showInformationMessage: async (message: string, ...rest: unknown[]) => {
      const detail = rest.find(
        (item): item is { detail?: string } =>
          typeof item === "object" && item !== null && "detail" in item
      )?.detail;
      shown.push(detail ? `${message}\n${detail}` : message);
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
  });
});

describe("確認の窓までの git の回数", () => {
  test("読み直しは上流と数だけ・根の確かめを使い回す（置き場1つで git は 14 本以下）", async () => {
    await syncAllWorks({ registry, monitor, run: runner });
    // 窓に届いた状態：fetch のあとの遅れ 4 が反映されている
    expect(shown.join("\n")).toContain("4");
    // 状態読みの命令（根の確かめ・status・remote・枝・上流・数え）の内訳
    const names = calls.map((args) => args.join(" "));
    // 根の確かめ（単独の --show-toplevel）は 1 本、状態読みでの重ねは無い
    expect(names.filter((n) => n === "rev-parse --is-inside-work-tree --show-toplevel")).toHaveLength(0);
    // 上流の解決は fetch の前後で 2 回、rev-list は 2 回（前と後）
    expect(names.filter((n) => n.startsWith("rev-parse --abbrev-ref"))).toHaveLength(2);
    // 内訳：根の確かめ1・最初の読み7（根の確かめは使い回して省く）・fetch 1・読み直し2・記録の数え1
    expect(calls).toHaveLength(12);
    // 作業木・remote・枝は fetch の前の 1 回だけ
    expect(names.filter((n) => n === "remote")).toHaveLength(1);
    expect(names.filter((n) => n.startsWith("symbolic-ref"))).toHaveLength(1);
  });
});
