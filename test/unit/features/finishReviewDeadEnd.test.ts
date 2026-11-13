import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// 編集者の写しは在るものとして扱う（作り物の道はディスクに無い）。無いときの決まりは
// `finishReviewMissingWork.test.ts` が見る（2026-11-14）
vi.mock("../../../src/core/workFolderPresence", () => ({
  isWorkFolderPresent: async () => true,
  findMissingWorks: async () => [],
}));
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

/*
  送れなかったときの理由（設計書5.7.5.4。作者の決定 2026-11-07「分けて知らせる」）。
  以前は git の文をそのまま「校閲を終えて返せませんでした: 送信に失敗しました: …」と出していた。
  GitHub とのやり取りで止まったら API の返事で理由を見分け、分かったときはその知らせだけを出す
*/
describe("校閲を終えて返す：GitHub へ送れなかったとき", () => {
  /** 本文は手つかず。台帳は記録済みで、送信と取り寄せが届かない写し */
  const unreachable: GitCommandRunner = async (args) => {
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "push" || args[0] === "fetch") {
      return { code: 128, stdout: "", stderr: "remote: Repository not found." };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const errors: string[] = [];
  beforeEach(() => {
    errors.length = 0;
    Object.assign(window, {
      showErrorMessage: async (message: string) => {
        errors.push(message);
        return undefined;
      },
    });
  });

  test("置き場に届かないと分かったら、その知らせだけを出し、git の文は画面に出さない", async () => {
    status = tracked();
    const noticed: string[] = [];
    const result = await finishReviewAndReturn(work, {
      run: unreachable,
      confirm: async () => true,
      whoAmI: async () => "編集者",
      noticeFetchTrouble: async (target) => {
        noticed.push(target.title);
        return { trouble: "revoked", shown: true };
      },
    });
    expect(result.kind === "failed" && result.trouble).toBe("revoked");
    expect(noticed).toEqual(["預かった作品"]);
    expect(errors).toEqual([]);
  });

  test("見分けて分からなければ、今までの失敗の知らせ", async () => {
    status = tracked();
    const result = await finishReviewAndReturn(work, {
      run: unreachable,
      confirm: async () => true,
      whoAmI: async () => "編集者",
      noticeFetchTrouble: async () => ({ trouble: "unknown", shown: false }),
    });
    expect(result.kind).toBe("failed");
    expect(errors.join("\n")).toContain("校閲を終えて返せませんでした");
  });

  test("手元の記録で止まったときは、見分けに回さない", async () => {
    status = tracked();
    const noticed = vi.fn();
    // 送る前の本文の確かめ（status）が読めない → GitHub へ行く前に止まる
    let statusCalls = 0;
    const localFailure: GitCommandRunner = async (args) => {
      if (args[0] === "status") {
        statusCalls += 1;
        // 1回目は「返す」の入口の確かめ（通す）、2回目は送りの頭の確かめ（読めない）
        return statusCalls === 1
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await finishReviewAndReturn(work, {
      run: localFailure,
      confirm: async () => true,
      whoAmI: async () => "編集者",
      noticeFetchTrouble: noticed,
    });
    expect(result.kind).toBe("failed");
    expect(noticed).not.toHaveBeenCalled();
  });
});
