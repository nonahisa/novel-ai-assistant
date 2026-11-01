import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { commands, window, workspace } from "../support/vscodeStub";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/*
  「校閲を終えて返す」の行き止まり（作者の判断 2026-11-01、洗い出しの3）。

  - 本文に書き換えがあると「変更を元に戻してからもう一度」と言うだけで、戻す道が無かった
    → VS Code のソース管理をボタンで開き、戻し方を1文で言う（ここでは戻さない。
      本文の書き換えを捨てるのは取り消せない）
  - 競合が残ると「『競合解決』で片づけて」と言ったが、その項目は詳細メニューから外した
    → 残す文を選ぶ画面をボタンで直に開く
*/

let status: GitSyncStatus;
vi.mock("../../../src/core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/git")>();
  return { ...actual, readSyncStatus: async () => status };
});
vi.mock("../../../src/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/logger")>();
  return { ...actual, logStep: () => undefined, logFailure: () => undefined, useLogFile: () => undefined };
});

const { finishReviewAndReturn } = await import("../../../src/features/finishReview");

const work = { id: "e1", title: "預かった作品", folderPath: "C:/写し" } as WorkEntry;

function tracked(over: Partial<Extract<GitSyncStatus, { kind: "tracked" }>> = {}): GitSyncStatus {
  return {
    kind: "tracked",
    root: "C:/写し",
    branch: "main",
    upstream: "origin/main",
    behind: 0,
    ahead: 0,
    dirty: 0,
    behindHere: 0,
    aheadHere: 0,
    dirtyHere: 0,
    unmerged: 0,
    ...over,
  };
}

/** 本文（台帳の外）に書き換えが1件ある写し */
const bodyChanged: GitCommandRunner = async (args) => {
  if (args[0] === "status") {
    return { code: 0, stdout: " M 本文/第1話.txt\u0000", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

const shown: Array<{ message: string; buttons: string[] }> = [];
const executed: string[] = [];
let pick: string | undefined;
const original = {
  getConfiguration: workspace.getConfiguration,
  executeCommand: commands.executeCommand,
  showWarningMessage: (window as Record<string, unknown>).showWarningMessage,
};

beforeEach(() => {
  shown.length = 0;
  executed.length = 0;
  pick = undefined;
  // 編集者モードにする（`actorContext.ts` の `currentMode` は設定 novelai.mode を読む）
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, fallback: T): T => (key === "mode" ? ("editor" as T) : fallback),
  })) as typeof workspace.getConfiguration;
  commands.executeCommand = async (command: string) => {
    executed.push(command);
    return undefined;
  };
  Object.assign(window, {
    showWarningMessage: async (message: string, ...rest: unknown[]) => {
      const buttons = rest.filter((item): item is string => typeof item === "string");
      shown.push({ message, buttons });
      return buttons.find((button) => button === pick);
    },
  });
});

afterEach(() => {
  workspace.getConfiguration = original.getConfiguration;
  commands.executeCommand = original.executeCommand;
  Object.assign(window, { showWarningMessage: original.showWarningMessage });
});

describe("校閲を終えて返す：本文の書き換えがあるとき", () => {
  test("送らずに止め、戻し方を1文で言い、ソース管理を開くボタンを出す", async () => {
    status = tracked({ dirty: 1 });
    pick = "ソース管理を開く";
    const result = await finishReviewAndReturn(work, { run: bodyChanged });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.kind).toBe("bodyChanged");
    expect(shown[0]?.message).toContain("変更を破棄");
    expect(shown[0]?.buttons).toContain("ソース管理を開く");
    expect(executed).toContain("workbench.view.scm");
  });
});

describe("校閲を終えて返す：残す文が決まっていないとき", () => {
  test("メニューに無い「競合解決」を指さず、残す文を選ぶ画面をボタンで開く", async () => {
    status = tracked({ unmerged: 1 });
    pick = "残す文を選ぶ";
    const result = await finishReviewAndReturn(work, { run: bodyChanged });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.kind).toBe("unmerged");
    expect(shown[0]?.message).not.toContain("「競合解決」");
    expect(shown[0]?.buttons).toContain("残す文を選ぶ");
    expect(executed).toContain("novelai.resolveConflicts");
  });
});
