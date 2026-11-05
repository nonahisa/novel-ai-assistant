import { beforeEach, describe, expect, test } from "vitest";
import { runStartupHandoff } from "../../../src/features/handoffSync";
import {
  logLine,
  setFallbackLogRoot,
  settleLogWrites,
  useLogFile,
  useLogFiles,
} from "../../../src/core/logger";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import { window, workspace } from "../support/vscodeStub";

/**
 * 開いたときの点検が、記録のファイルを何回読み書きするか（2026-11-05）。
 *
 * 書庫（置き場1つに作品7つ）の点検が 0.127.3 から遅くなった見込みの原因は、
 * 記録を「関わった作品それぞれ」へ書くようにしたこと。1行ごとにファイルを丸ごと読んで
 * 書き直すので、書き先が7つなら1行で読み書き14回になる。
 * 直し方は2つ：何もしなかった回は書き先を全作品へ向けない／溜まった行は1回の読み書きにまとめる。
 */

const ROOT = "C:/書庫";
const works = Array.from({ length: 7 }, (_, index) => ({
  id: `w${index}`,
  title: `作品${index}`,
  folderPath: `${ROOT}/作品${index}`,
}));

let reads: number;
let writes: number;
let written: Map<string, string>;

beforeEach(() => {
  reads = 0;
  writes = 0;
  written = new Map();
  Object.assign(workspace, {
    fs: {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        reads += 1;
        const text = written.get(uri.fsPath);
        if (text === undefined) throw new Error("まだ無い");
        return new TextEncoder().encode(text);
      },
      writeFile: async (uri: { fsPath: string }, data: Uint8Array) => {
        writes += 1;
        written.set(uri.fsPath, new TextDecoder().decode(data));
      },
    },
  });
  Object.assign(window, { showWarningMessage: async () => undefined });
  setFallbackLogRoot("C:/storage");
  useLogFile(undefined);
});

function makeGit(scenario: { ahead: number; behindAfterFetch: number }): GitCommandRunner {
  let behind = 0;
  let ahead = scenario.ahead;
  return async (args, cwd) => {
    const joined = args.join(" ");
    if (args[0] === "--version") return { code: 0, stdout: "git version 2.55.0", stderr: "" };
    if (!cwd.startsWith(ROOT)) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: ROOT, stderr: "" };
    if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
      return { code: 0, stdout: `true\n${ROOT}`, stderr: "" };
    }
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
    if (joined.startsWith("rev-parse --abbrev-ref")) return { code: 0, stdout: "origin/main", stderr: "" };
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
}

function deps(runner: GitCommandRunner) {
  const store: Record<string, unknown> = {};
  const monitor = {
    refreshAll: async () => undefined,
    refreshRoot: async () => ({ kind: "not_a_repo" }) as GitSyncStatus,
    refresh: async () => ({ kind: "not_a_repo" }) as GitSyncStatus,
    statusFor: () => undefined,
  };
  return {
    registry: { list: () => works } as never,
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

describe("開いたときの点検の記録の読み書き（書庫1つに作品7つ）", () => {
  test("何もしなかった回は、記録を1回も読み書きしない", async () => {
    await runStartupHandoff(deps(makeGit({ ahead: 0, behindAfterFetch: 0 })));
    // 点検と同じ時間帯にほかの処理が1行書いても、全作品の7ファイルへは行かない
    logLine("点検のあとの、ほかの処理の1行");
    await settleLogWrites();
    // 直す前：点検が書き先を全作品へ向けたまま残り、この1行が7ファイルの読み書き（読み7回・書き7回）になっていた
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    expect([...written.keys()].some((file) => file.includes("作品"))).toBe(false);
  });

  test("取り込んだ回は、関わった作品（全作品）のログに1行ずつ残り、読み書きは作品数ぶん", async () => {
    await runStartupHandoff(deps(makeGit({ ahead: 0, behindAfterFetch: 3 })));
    await settleLogWrites();
    expect(written.size).toBe(7);
    for (const text of written.values()) expect(text).toContain("開いたときに取り込んだ");
    expect(reads).toBe(7);
    expect(writes).toBe(7);
  });
});

describe("記録の書き込みをまとめる", () => {
  test("同じ時に出た複数行は、書き先ごとに1回の読み書きで書き、順序と中身は変わらない", async () => {
    useLogFiles(["C:/works/a", "C:/works/b"]);
    logLine("一行目");
    logLine("二行目");
    logLine("三行目");
    await settleLogWrites();
    // 直す前は 3行×2か所＝読み6回・書き6回
    expect(reads).toBe(2);
    expect(writes).toBe(2);
    for (const text of written.values()) {
      const lines = text.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("一行目");
      expect(lines[1]).toContain("二行目");
      expect(lines[2]).toContain("三行目");
    }
  });

  test("書き込みが終わってから出た行は、前の行を消さずに足される", async () => {
    useLogFile("C:/works/a");
    logLine("先");
    await settleLogWrites();
    logLine("後");
    await settleLogWrites();
    const [text] = [...written.values()];
    expect(text.trimEnd().split("\n").map((line) => line.replace(/^\[[^\]]*\] /, ""))).toEqual(["先", "後"]);
  });
});
