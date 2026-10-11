import { afterEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「未取得です［取り込む］［このまま開く］」の知らせの答えを、数え直しの中で
 * 待たない（2026-10-11、0.103.9）。
 *
 * エディターを切り替えたときの数え直し（`refresh` の `notify: true`）は、
 * 走っているあいだ `refreshing` の印を立てる。フォルダーの見張りはこの印を
 * 見て待ち直すので、作者が知らせを押さずに置くと、その作品の同期の状態の
 * 数え直しが待ち続けた。
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
  showLog: vi.fn(),
}));

// 状態の読みだけを差し替える（別の環境で2件進んでいる、を作る）
const behindStatus: GitSyncStatus = {
  kind: "tracked",
  root: "C:\\novels\\w1",
  branch: "main",
  upstream: "origin/main",
  behind: 2,
  ahead: 0,
  behindHere: 2,
  aheadHere: 0,
  dirty: 0,
  dirtyHere: 0,
  unmerged: 0,
};
vi.mock("../../../src/core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/git")>();
  return {
    ...actual,
    readSyncStatus: vi.fn(async () => behindStatus),
  };
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

const settle = () => new Promise((done) => setTimeout(done, 10));

type Answer = string | undefined;
const originalWarning = vscode.window.showWarningMessage;

afterEach(() => {
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage =
    originalWarning;
});

/** 知らせを出したまま、作者がまだ答えていない形にする */
function holdWarning(): { answer: (value: Answer) => void; shown: string[] } {
  const shown: string[] = [];
  let answer: (value: Answer) => void = () => undefined;
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (
    message: string
  ) => {
    shown.push(message);
    if (!message.includes("未取得")) return Promise.resolve(undefined);
    return new Promise<Answer>((resolve) => {
      answer = resolve;
    });
  };
  return { answer: (value) => answer(value), shown };
}

function newMonitor() {
  const run: GitCommandRunner = async () => ({ code: 1, stdout: "", stderr: "" });
  const monitor = new GitSyncMonitor(registry as never, { run });
  const pulled: string[] = [];
  (monitor as unknown as { pull: (work: WorkEntry) => Promise<boolean> }).pull =
    async (work) => {
      pulled.push(work.id);
      return true;
    };
  return { monitor, pulled };
}

function isRefreshing(monitor: unknown, id: string): boolean {
  return (monitor as { refreshing: Set<string> }).refreshing.has(id);
}

describe("未取得の知らせは、数え直しの印を立てたまま待たない", () => {
  test("答えを待たずに refresh() が戻り、印も下りている", async () => {
    const held = holdWarning();
    const { monitor } = newMonitor();
    try {
      let returned = false;
      void monitor.refresh(target, { fetch: false, notify: true }).then(() => {
        returned = true;
      });
      await settle();
      expect(held.shown.some((text) => text.includes("未取得"))).toBe(true);
      // 作者はまだ押していない
      expect(returned).toBe(true);
      expect(isRefreshing(monitor, "w1")).toBe(false);
    } finally {
      monitor.dispose();
    }
  });

  test("［取り込む］を後から押すと取り込む", async () => {
    const held = holdWarning();
    const { monitor, pulled } = newMonitor();
    try {
      await monitor.refresh(target, { fetch: false, notify: true });
      expect(pulled).toEqual([]);
      held.answer("取り込む");
      await settle();
      expect(pulled).toEqual(["w1"]);
    } finally {
      monitor.dispose();
    }
  });

  test("［このまま開く］なら取り込まない", async () => {
    const held = holdWarning();
    const { monitor, pulled } = newMonitor();
    try {
      await monitor.refresh(target, { fetch: false, notify: true });
      held.answer("このまま開く");
      await settle();
      expect(pulled).toEqual([]);
    } finally {
      monitor.dispose();
    }
  });
});
