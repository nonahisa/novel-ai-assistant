import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  useLogFile: vi.fn(),
}));

import { AutoResender, type AutoResendSettings } from "../../../src/features/autoResend";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { logFailure, logStep } from "../../../src/core/logger";
import { statusBarMessages, window } from "../support/vscodeStub";

/**
 * 回線が戻ったら、記録済みで送れていない分を送り直す（設計書6.15.1）。
 *
 * **再現の筋書き**（2026-10-01、作者のノートPC）：「すべて同期」で記録は
 * 済んだが、スリープ明けで回線が無く送信だけが失敗した。窓は出たが作者は
 * 机のPCへ移っていて見ておらず、3時間 GitHub に届かなかった。
 *
 * ここでは作り物の git で、**送る場面・送らない場面・失敗しても窓を
 * 出さないこと**を確かめる。本物の git は呼ばない。
 */

const library = "C:/書庫";
const works: WorkEntry[] = [
  { id: "w1", title: "いじめられっ子", folderPath: "C:/書庫/いじめられっ子" },
  { id: "w2", title: "ハイエルフ未亡人", folderPath: "C:/書庫/ハイエルフ未亡人" },
] as WorkEntry[];
const registry = { list: () => works };

function tracked(behind: number, ahead: number, unmerged = 0): GitSyncStatus {
  return {
    kind: "tracked",
    root: library,
    branch: "main",
    upstream: "origin/main",
    behind,
    ahead,
    behindHere: behind,
    aheadHere: ahead,
    dirty: 0,
    dirtyHere: 0,
    unmerged,
  };
}

/** 作り物の git の中身。試験ごとに書き換える */
let repo: {
  behind: number;
  ahead: number;
  online: boolean;
  merging: boolean;
};
/** 呼ばれた git（副コマンドの並び） */
let calls: string[][];

const fakeGit: GitCommandRunner = async (args) => {
  calls.push(args);
  const joined = args.join(" ");
  if (joined === "rev-parse --is-inside-work-tree") {
    return { code: 0, stdout: "true", stderr: "" };
  }
  if (joined === "rev-parse --show-toplevel") {
    return { code: 0, stdout: library, stderr: "" };
  }
  if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
  if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
  if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
  if (joined.startsWith("rev-parse --abbrev-ref")) {
    return { code: 0, stdout: "origin/main", stderr: "" };
  }
  if (args[0] === "rev-list") {
    return { code: 0, stdout: `${repo.behind}\t${repo.ahead}`, stderr: "" };
  }
  if (joined.startsWith("rev-parse -q --verify")) {
    const merging = repo.merging && args[args.length - 1] === "MERGE_HEAD";
    return merging
      ? { code: 0, stdout: "abc\n", stderr: "" }
      : { code: 1, stdout: "", stderr: "" };
  }
  if (args[0] === "push") {
    if (!repo.online) {
      return {
        code: 128,
        stdout: "",
        stderr: "fatal: unable to access 'https://github.com/': Could not resolve host: github.com",
      };
    }
    repo.ahead = 0;
    return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

/** 見張りの控え（作品ごと）。`refresh` で作り物の git から読み直す */
let cached: Map<string, GitSyncStatus>;
let refreshed: string[];
let operating: boolean;

const monitor = {
  statusFor: (id: string) => cached.get(id),
  refresh: async (work: WorkEntry) => {
    refreshed.push(work.id);
    const status = tracked(repo.behind, repo.ahead);
    cached.set(work.id, status);
    return status;
  },
  isOperating: () => operating,
} as unknown as GitSyncMonitorLike;

let windowsShown: string[];
let busy: boolean;
let settings: AutoResendSettings;
let clock: number;
let afterSent: number;

function makeResender(): AutoResender {
  return new AutoResender({
    registry,
    monitor,
    run: fakeGit,
    isSyncBusy: () => busy,
    settings: () => settings,
    now: () => clock,
    afterSent: async () => {
      afterSent += 1;
    },
  });
}

const pushes = (): string[][] => calls.filter((args) => args[0] === "push");

beforeEach(() => {
  repo = { behind: 0, ahead: 2, online: false, merging: false };
  calls = [];
  cached = new Map(works.map((work) => [work.id, tracked(0, 2)]));
  refreshed = [];
  operating = false;
  busy = false;
  settings = { enabled: true, intervalMinutes: 5 };
  clock = 1_000_000_000;
  afterSent = 0;
  windowsShown = [];
  statusBarMessages.length = 0;
  vi.mocked(logFailure).mockClear();
  vi.mocked(logStep).mockClear();
  const record = async (message: string) => {
    windowsShown.push(message);
    return undefined;
  };
  Object.assign(window, {
    showInformationMessage: record,
    showWarningMessage: record,
    showErrorMessage: record,
  });
});

describe("回線が戻ったら送り直す（2026-10-01 の再現）", () => {
  test("回線が無い間は失敗しても窓を出さず、戻ったら送って短く知らせる", async () => {
    const resender = makeResender();

    // スリープ明け直後：回線がまだ無い
    const first = await resender.attempt("wake");
    expect(pushes()).toHaveLength(1);
    expect(first?.failed).toHaveLength(1);
    expect(windowsShown).toEqual([]);
    expect(statusBarMessages).toEqual([]);
    // ログには1行残す
    expect(logFailure).toHaveBeenCalledTimes(1);
    expect(afterSent).toBe(0);

    // 同じ理由でまた失敗しても、ログを積み増さない
    await resender.attempt("interval");
    expect(pushes()).toHaveLength(2);
    expect(logFailure).toHaveBeenCalledTimes(1);

    // 回線が戻った
    repo.online = true;
    const third = await resender.attempt("interval");
    expect(pushes()).toHaveLength(3);
    expect(third?.sent).toEqual([{ label: "書庫", ahead: 2 }]);
    expect(windowsShown).toEqual([]);
    expect(statusBarMessages.map((one) => one.text).join("\n")).toContain(
      "送れていなかった 2件を GitHub へ送りました"
    );
    // 控えを作り直し、「送らずに閉じた」印を付け直す
    expect(refreshed.sort()).toEqual(["w1", "w2"]);
    expect(afterSent).toBe(1);
    expect(vi.mocked(logStep).mock.calls.flat().join("\n")).toContain(
      "それまでに 2回失敗"
    );

    // 送ったあとは、もう git を呼ばない
    const before = calls.length;
    await resender.attempt("interval");
    expect(calls.length).toBe(before);
  });

  test("押し付け（force）は決してしない", async () => {
    repo.online = true;
    await makeResender().attempt("interval");
    expect(pushes()).toEqual([["push"]]);
  });
});

describe("送らないとき", () => {
  test("別の環境のほうが進んでいれば、git を呼ばない", async () => {
    cached = new Map(works.map((work) => [work.id, tracked(1, 0)]));
    await makeResender().attempt("interval");
    expect(calls).toEqual([]);
  });

  test("分かれていれば送らない（控えの時点で分かる）", async () => {
    cached = new Map(works.map((work) => [work.id, tracked(3, 2)]));
    await makeResender().attempt("interval");
    expect(calls).toEqual([]);
  });

  test("控えが古くても、送る直前に手元で見直して分かれていれば送らない", async () => {
    repo.behind = 1;
    repo.online = true;
    const result = await makeResender().attempt("interval");
    expect(pushes()).toEqual([]);
    expect(result?.skipped[0]?.reason).toBe("behind");
    // 控えを正しておく（次の間隔で同じ見直しを繰り返さない）
    expect(refreshed.sort()).toEqual(["w1", "w2"]);
  });

  test("競合が残っていれば送らない", async () => {
    cached = new Map(works.map((work) => [work.id, tracked(0, 2, 1)]));
    await makeResender().attempt("interval");
    expect(calls).toEqual([]);
  });

  test("合流の途中（競合を解いて記録する前）は送らない", async () => {
    repo.merging = true;
    repo.online = true;
    const result = await makeResender().attempt("interval");
    expect(pushes()).toEqual([]);
    expect(result?.skipped[0]?.reason).toContain("MERGE_HEAD");
  });

  test("同期そのものが走っている最中は、git を呼ばない", async () => {
    busy = true;
    await makeResender().attempt("interval");
    expect(calls).toEqual([]);
  });

  test("見張りが取り込み・送信をしている最中も、git を呼ばない", async () => {
    operating = true;
    await makeResender().attempt("interval");
    expect(calls).toEqual([]);
  });

  test("設定で切っていれば何もしない", async () => {
    settings = { enabled: false, intervalMinutes: 5 };
    await makeResender().attempt("interval");
    expect(calls).toEqual([]);
  });

  test("git の無い環境（控えが git_missing）では何もしない", async () => {
    cached = new Map(works.map((work) => [work.id, { kind: "git_missing" } as GitSyncStatus]));
    await makeResender().attempt("interval");
    expect(calls).toEqual([]);
  });
});

describe("いつ試すか", () => {
  test("鼓動は間隔が過ぎるまで試さない", async () => {
    const resender = makeResender();
    await resender.heartbeat();
    expect(pushes()).toHaveLength(1);

    clock += 60_000;
    await resender.heartbeat();
    expect(pushes()).toHaveLength(1);

    clock += 4 * 60_000;
    await resender.heartbeat();
    expect(pushes()).toHaveLength(2);
  });

  test("鼓動の間が大きく飛んだら（スリープ明け）、間隔に関わらずその場と次の鼓動で試す", async () => {
    const resender = makeResender();
    await resender.heartbeat();
    expect(pushes()).toHaveLength(1);

    // 3時間眠っていた
    clock += 3 * 60 * 60_000;
    await resender.heartbeat();
    expect(pushes()).toHaveLength(2);

    // 起きた直後は回線がまだ無いことが多いので、次の鼓動でもう一度
    clock += 60_000;
    await resender.heartbeat();
    expect(pushes()).toHaveLength(3);

    // そのあとは間隔どおり
    clock += 60_000;
    await resender.heartbeat();
    expect(pushes()).toHaveLength(3);
  });

  test("ウィンドウへ戻ったときは試すが、行き来のたびには試さない", async () => {
    const resender = makeResender();
    await resender.onFocus();
    expect(pushes()).toHaveLength(1);
    clock += 10_000;
    await resender.onFocus();
    expect(pushes()).toHaveLength(1);
    clock += 30_000;
    await resender.onFocus();
    expect(pushes()).toHaveLength(2);
  });

  test("送るものが無い回は時刻を進めない（新しく溜まったら次の鼓動ですぐ試す）", async () => {
    cached = new Map(works.map((work) => [work.id, tracked(0, 0)]));
    const resender = makeResender();
    await resender.heartbeat();
    expect(calls).toEqual([]);

    // すべて同期の送信が失敗して、送れていない分ができた
    cached = new Map(works.map((work) => [work.id, tracked(0, 2)]));
    clock += 60_000;
    await resender.heartbeat();
    expect(pushes()).toHaveLength(1);
  });
});
