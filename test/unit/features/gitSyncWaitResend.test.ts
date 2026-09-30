import { describe, expect, test, vi } from "vitest";
import type { GitCommandRunner } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 見張りの取り込み・送信は、走っている自動の送り直しを待ってから始める
 * （設計書6.15.1）。
 *
 * 「未取得です」の知らせの［取り込む］はコマンドを通らずに見張りの `pull` を
 * 呼ぶので、コマンドの入口の待ちだけでは塞げない。**待っているあいだに
 * git を1本も起こさないこと**を見る。
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
  showLog: vi.fn(),
}));

const { GitSyncMonitor } = await import("../../../src/features/gitSync");

const target: WorkEntry = {
  id: "w1",
  title: "作品",
  folderPath: "C:\\novels\\w1",
  registeredAt: "2026-10-01T00:00:00.000Z",
};

const registry = {
  list: () => [],
  onDidChange: () => ({ dispose: () => undefined }),
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 少し先まで進めて、待ちの途中の様子を見る */
const settle = () => new Promise((done) => setTimeout(done, 10));

describe("見張りの取り込み・送信は、送り直しを待つ", () => {
  for (const operation of ["pull", "push"] as const) {
    test(`${operation}：待ちが解けるまで git を起こさない`, async () => {
      const calls: string[] = [];
      const run: GitCommandRunner = async (args) => {
        calls.push(args.join(" "));
        return { code: 1, stdout: "", stderr: "" };
      };
      const monitor = new GitSyncMonitor(registry as never, { run });
      try {
        const gate = deferred();
        monitor.setBeforeOperation(() => gate.promise);

        const running = monitor[operation](target);
        await settle();
        expect(calls).toEqual([]);
        // 待っているあいだも「走っている」と数える（送り直しの次の試行を始めさせない）
        expect(monitor.isOperating()).toBe(true);

        gate.resolve();
        await running;
        expect(calls.length).toBeGreaterThan(0);
        expect(monitor.isOperating()).toBe(false);
      } finally {
        monitor.dispose();
      }
    });
  }

  test("待ちが失敗しても、作者の操作は止めない", async () => {
    const calls: string[] = [];
    const run: GitCommandRunner = async (args) => {
      calls.push(args.join(" "));
      return { code: 1, stdout: "", stderr: "" };
    };
    const monitor = new GitSyncMonitor(registry as never, { run });
    try {
      monitor.setBeforeOperation(() => Promise.reject(new Error("待てない")));
      await monitor.push(target);
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      monitor.dispose();
    }
  });
});
