import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  showLog: vi.fn(),
  useLogFile: vi.fn(),
  useLogFiles: vi.fn(),
}));
vi.mock("../../../src/features/syncLog", () => ({ useSyncLog: async () => undefined }));
// 作品のフォルダーは在るものとして扱う（作り物の道はディスクに無い）
vi.mock("../../../src/core/workFolderPresence", () => ({
  isWorkFolderPresent: async () => true,
  findMissingWorks: async () => [],
}));

import { AutoResender } from "../../../src/features/autoResend";
import { PushRejectionMemory } from "../../../src/features/pushRejectionMemory";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { window } from "../support/vscodeStub";

/**
 * 自動の送り直しが、同じ断られ方を何度も繰り返さない（設計書5.5.21。2026-11-14 の作者の実機）。
 *
 * 100MB を超えるファイルの入った記録を、送り直しは5分おきに送っては GitHub に断られていた
 * （直す前は、失敗の理由を問わず次の機会にまた試していた）。**同じ記録（HEAD）で断られたら、
 * 記録が変わるまで試さない。** 回線が無いだけの失敗は、今までどおり試し続ける。
 */

const root = "C:/書庫";
const works: WorkEntry[] = [
  { id: "w1", title: "確認用コピー", folderPath: "C:/書庫/確認用コピー" },
] as WorkEntry[];

const tracked: GitSyncStatus = {
  kind: "tracked",
  root,
  branch: "main",
  upstream: "origin/main",
  behind: 0,
  ahead: 1,
  behindHere: 0,
  aheadHere: 1,
  dirty: 0,
  dirtyHere: 0,
  unmerged: 0,
};

/** 作り物の git の中身 */
let repo: {
  head: string;
  answer: "rejected" | "fetchFirst" | "offline" | "ok";
  bigInHead: boolean;
};
let calls: string[][];
let shown: string[];
let clock: number;

const rejection = [
  "warning: in the working copy of '確認用コピー/本文/001.txt', LF will be replaced by CRLF the next time Git touches it",
  "remote: error: GH001: Large files detected.",
  "remote: error: File 素材/big.zip is 722.00 MB; this exceeds GitHub's file size limit of 100.00 MB",
  "To https://github.com/example/library.git",
  " ! [remote rejected] main -> main (pre-receive hook declined)",
  "error: failed to push some refs to 'https://github.com/example/library.git'",
].join("\n");

const fakeGit: GitCommandRunner = async (args) => {
  calls.push(args);
  const joined = args.join(" ");
  if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
    return { code: 0, stdout: `true\n${root}`, stderr: "" };
  }
  if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: root, stderr: "" };
  if (joined === "rev-parse HEAD") return { code: 0, stdout: `${repo.head}\n`, stderr: "" };
  if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
  if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
  if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
  if (joined.startsWith("rev-parse --abbrev-ref")) {
    return { code: 0, stdout: "origin/main", stderr: "" };
  }
  if (args[0] === "rev-list") return { code: 0, stdout: "0\t1", stderr: "" };
  if (joined.startsWith("rev-parse -q --verify")) return { code: 1, stdout: "", stderr: "" };
  if (args[0] === "log" && repo.bigInHead) {
    return { code: 0, stdout: "素材/big.zip\u0000", stderr: "" };
  }
  if (args[0] === "ls-tree" && repo.bigInHead) {
    return {
      code: 0,
      stdout: "100644 blob 1111111111111111111111111111111111111111  757071872\t素材/big.zip\u0000",
      stderr: "",
    };
  }
  if (args[0] === "push") {
    if (repo.answer === "rejected") return { code: 1, stdout: "", stderr: rejection };
    if (repo.answer === "fetchFirst") {
      return {
        code: 1,
        stdout: "",
        stderr:
          "To https://github.com/example/library.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs",
      };
    }
    if (repo.answer === "offline") {
      return {
        code: 128,
        stdout: "",
        stderr: "fatal: unable to access 'https://github.com/': Could not resolve host: github.com",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

const monitor = {
  statusFor: () => tracked,
  refresh: async () => tracked,
  isOperating: () => false,
} as unknown as GitSyncMonitorLike;

function makeResender(): AutoResender {
  return new AutoResender({
    registry: { list: () => works },
    monitor,
    run: fakeGit,
    isSyncBusy: () => false,
    settings: () => ({ enabled: true, intervalMinutes: 5 }),
    now: () => clock,
    rejections: new PushRejectionMemory(),
  });
}

const pushes = (): number => calls.filter((args) => args[0] === "push").length;

beforeEach(() => {
  repo = { head: "a".repeat(40), answer: "rejected", bigInHead: false };
  calls = [];
  shown = [];
  clock = 1_000_000_000;
  const record = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  Object.assign(window, {
    showInformationMessage: record,
    showWarningMessage: record,
    showErrorMessage: record,
  });
});

describe("断られた記録は、記録が変わるまで送り直さない", () => {
  test("同じ HEAD で断られたら2回目は送らない。知らせは1回だけで、理由は断りの文", async () => {
    const resender = makeResender();
    await resender.attempt("interval");
    expect(pushes()).toBe(1);

    clock += 10 * 60_000;
    const second = await resender.attempt("interval");
    clock += 10 * 60_000;
    await resender.attempt("wake");
    expect(pushes()).toBe(1);
    expect(second?.skipped.map((one) => one.reason)).toEqual(["同じ記録を GitHub に断られた"]);

    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("GitHub に送るのを断られました。");
    expect(shown[0]).toContain("this exceeds GitHub's file size limit of 100.00 MB");
    expect(shown[0]).not.toContain("LF will be replaced");
  });

  test("記録が変われば（HEAD が別のもの）また試す", async () => {
    const resender = makeResender();
    await resender.attempt("interval");
    repo.head = "b".repeat(40);
    repo.answer = "ok";
    clock += 10 * 60_000;
    const next = await resender.attempt("interval");
    expect(pushes()).toBe(2);
    expect(next?.sent).toHaveLength(1);
  });

  test("回線が無いだけなら、今までどおり試し続け、窓も出さない", async () => {
    repo.answer = "offline";
    const resender = makeResender();
    await resender.attempt("interval");
    clock += 10 * 60_000;
    await resender.attempt("interval");
    expect(pushes()).toBe(2);
    expect(shown).toEqual([]);
  });

  test("別の機械が先に送っていただけ（fetch first）なら、断られた扱いにせず窓も出さない", async () => {
    repo.answer = "fetchFirst";
    const resender = makeResender();
    await resender.attempt("interval");
    clock += 10 * 60_000;
    await resender.attempt("interval");
    expect(pushes()).toBe(2);
    expect(shown).toEqual([]);
  });

  test("送る記録に 100MB を超えるファイルがあれば、送らずに1回だけ知らせる", async () => {
    repo.bigInHead = true;
    const resender = makeResender();
    await resender.attempt("interval");
    clock += 10 * 60_000;
    await resender.attempt("interval");
    expect(pushes()).toBe(0);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("・素材/big.zip（722.0MB）");
  });
});
