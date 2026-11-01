import { afterEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 受け取るだけの口（`GitSyncMonitor.receive`。2026-11-01）。原稿箱の取り込みの前に使う。
 *
 * 以前は原稿箱の前の受け取りが `pull` を写したもので、
 * - 未記録の変更があると［記録してから取り込む］の問いを出してすぐ戻り、原稿箱の
 *   「受け取れなかった」と問いが並んだ
 * - 取り込みの終わりの数え直しが「原稿箱に N件届いています［取り込む］」を出し、
 *   押すと（このあと原稿箱の取り込みが読んだあとなので）「取り込み待ちはありません」になった
 *
 * 受け取るだけの口は、**問いも知らせも出さず**、受け取りの最中は箱の知らせも黙る。
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
  showLog: vi.fn(),
}));

const autostash = vi.fn(async () => ({ ok: true }) as const);
vi.mock("../../../src/core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/git")>();
  return { ...actual, pullFastForwardAutostash: () => autostash() };
});

const { GitSyncMonitor } = await import("../../../src/features/gitSync");

const target: WorkEntry = {
  id: "w1",
  title: "作品",
  folderPath: "C:\\novels\\w1",
  registeredAt: "2026-10-01T00:00:00.000Z",
};

const registry = {
  list: () => [],
  get: () => undefined,
  onDidChange: () => ({ dispose: () => undefined }),
};

function tracked(over: Partial<Extract<GitSyncStatus, { kind: "tracked" }>>): GitSyncStatus {
  return {
    kind: "tracked",
    root: "C:\\novels\\w1",
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

const originals = {
  warning: vscode.window.showWarningMessage,
  info: vscode.window.showInformationMessage,
};
afterEach(() => {
  Object.assign(vscode.window, {
    showWarningMessage: originals.warning,
    showInformationMessage: originals.info,
  });
  autostash.mockClear();
});

interface Internals {
  refresh: (work: WorkEntry, options: unknown) => Promise<GitSyncStatus>;
  refreshRoot: (work: WorkEntry, options: unknown) => Promise<void>;
  inboxArrived: (work: WorkEntry) => void;
  notifyInbox: (work: WorkEntry) => void;
}

function monitorWith(status: GitSyncStatus) {
  const run: GitCommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
  const monitor = new GitSyncMonitor(registry as never, { run });
  const inner = monitor as unknown as Internals;
  const inboxNotices: string[] = [];
  inner.refresh = async () => status;
  inner.notifyInbox = (work) => inboxNotices.push(work.id);
  // 取り込みの終わりの数え直しで、原稿箱が届いたのを見つけた体にする
  inner.refreshRoot = async (work) => inner.inboxArrived(work);
  const shown: string[] = [];
  Object.assign(vscode.window, {
    showWarningMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
    showInformationMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
  });
  return { monitor, inner, inboxNotices, shown };
}

describe("受け取るだけの口", () => {
  test("未記録の変更があっても問いを出さず、書きかけを退避して早送りで受け取る", async () => {
    const { monitor, shown } = monitorWith(tracked({ behind: 2, dirty: 1 }));
    try {
      const outcome = await monitor.receive(target);
      expect(outcome).toEqual({ kind: "received", behind: 2 });
      expect(autostash).toHaveBeenCalledTimes(1);
      expect(shown).toEqual([]);
    } finally {
      monitor.dispose();
    }
  });

  test("受け取りの最中は「原稿箱に N件届いています」を出さない（終わったあとは出す）", async () => {
    const { monitor, inner, inboxNotices } = monitorWith(tracked({ behind: 1 }));
    try {
      await monitor.receive(target);
      expect(inboxNotices).toEqual([]);
      inner.inboxArrived(target);
      expect(inboxNotices).toEqual(["w1"]);
    } finally {
      monitor.dispose();
    }
  });

  test("分かれている置き場には触らず、理由を1文で返す（「保存・同期」へ）", async () => {
    const { monitor, shown } = monitorWith(tracked({ behind: 1, ahead: 1 }));
    try {
      const outcome = await monitor.receive(target);
      expect(outcome.kind).toBe("skipped");
      if (outcome.kind === "skipped") expect(outcome.reason).toContain("「保存・同期」");
      expect(autostash).not.toHaveBeenCalled();
      expect(shown).toEqual([]);
    } finally {
      monitor.dispose();
    }
  });

  test("遅れていなければ何もしない", async () => {
    const { monitor } = monitorWith(tracked({ dirty: 3 }));
    try {
      expect(await monitor.receive(target)).toEqual({ kind: "nothing" });
      expect(autostash).not.toHaveBeenCalled();
    } finally {
      monitor.dispose();
    }
  });
});
