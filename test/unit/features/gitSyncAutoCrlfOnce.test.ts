import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import type { GitCommandRunner } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 取り込みで改行が書き換わりうる注意（`core.autocrlf=true`）は、
 * **作品ごとに一度だけ**出す（設計書5.5.1。実機確認リスト F-6 の代わり）。
 *
 * 取り込むたびに出すと、閉じても閉じても出る消せない表示になる。
 * 1回目に出ることは `autoCrlf.test.ts` が文言で見ている。ここで見るのは
 * **2回目以降に出ないこと**と、**別の作品では改めて出ること**である
 * （後者が無いと「一度出したら二度と誰にも出さない」実装でも通ってしまう）。
 */

// 記録の書き先はこの試験の対象ではない。ディスクへ行かせない
vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
}));

const { GitSyncMonitor } = await import("../../../src/features/gitSync");

function work(id: string): WorkEntry {
  return {
    id,
    title: `作品${id}`,
    folderPath: `C:\\novels\\${id}`,
    registeredAt: "2026-09-25T00:00:00.000Z",
  };
}

/** `git config core.autocrlf` に `true` と答える git の代役 */
const autoCrlfTrue: GitCommandRunner = async (args) =>
  args[0] === "config" && args[1] === "core.autocrlf"
    ? { code: 0, stdout: "true\n", stderr: "" }
    : { code: 1, stdout: "", stderr: "" };

/** 登録簿の代役。見張りは張らなくてよいので、作品は無しにしておく */
const registry = {
  list: () => [],
  onDidChange: () => ({ dispose: () => undefined }),
};

let warnings: string[] = [];
const originalWarning = window.showWarningMessage;

beforeEach(() => {
  warnings = [];
  window.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return undefined;
  }) as typeof window.showWarningMessage;
});

afterEach(() => {
  window.showWarningMessage = originalWarning;
});

/** 取り込みの入口が最初に呼ぶ注意を、そのまま呼ぶ */
async function warn(
  monitor: InstanceType<typeof GitSyncMonitor>,
  target: WorkEntry
): Promise<void> {
  await (
    monitor as unknown as { warnAutoCrlfOnce(work: WorkEntry): Promise<void> }
  ).warnAutoCrlfOnce(target);
}

describe("改行が書き換わりうる注意（autocrlf）", () => {
  test("同じ作品では、2回目以降は出さない", async () => {
    const monitor = new GitSyncMonitor(registry as never, { run: autoCrlfTrue });
    try {
      const target = work("w1");
      await warn(monitor, target);
      await warn(monitor, target);
      await warn(monitor, target);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("改行コードが変わることがあります");
    } finally {
      monitor.dispose();
    }
  });

  test("別の作品では、改めて1回出す", async () => {
    const monitor = new GitSyncMonitor(registry as never, { run: autoCrlfTrue });
    try {
      await warn(monitor, work("w1"));
      await warn(monitor, work("w2"));
      await warn(monitor, work("w2"));

      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toContain("作品w2");
    } finally {
      monitor.dispose();
    }
  });

  test("取り込みの入口は、取り込む前にこの注意を通る", () => {
    // 上の2つは注意そのものを呼んでいる。**取り込み（pull）が本当にここを
    // 通るか**は、入口のコードにしか書いていない
    const source = readFileSync("src/features/gitSync.ts", "utf8");
    const pull = source.slice(source.indexOf("async pull(work: WorkEntry"));
    const warnAt = pull.indexOf("await this.warnAutoCrlfOnce(work);");
    const pullAt = pull.indexOf("pullFastForward(");

    expect(warnAt).toBeGreaterThan(-1);
    expect(pullAt).toBeGreaterThan(warnAt);
  });
});
