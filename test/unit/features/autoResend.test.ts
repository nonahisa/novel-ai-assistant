import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  useLogFile: vi.fn(),
}));

import {
  AutoResender,
  WAIT_LIMIT_MS,
  type AutoResendSettings,
} from "../../../src/features/autoResend";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { logFailure, logStep, useLogFile } from "../../../src/core/logger";
import { statusBarMessages, window, workspace } from "../support/vscodeStub";

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
  /** `git status --porcelain` の答え（記録していない変更） */
  porcelain?: string;
};
/** 呼ばれた git（副コマンドの並び） */
let calls: string[][];
/** 立っていれば、push はこれが解けるまで返らない */
let pushGate: Promise<void> | undefined;

const fakeGit: GitCommandRunner = async (args) => {
  calls.push(args);
  const joined = args.join(" ");
  if (joined === "rev-parse --is-inside-work-tree") {
    return { code: 0, stdout: "true", stderr: "" };
  }
  if (joined === "rev-parse --show-toplevel") {
    return { code: 0, stdout: library, stderr: "" };
  }
  if (args[0] === "status") return { code: 0, stdout: repo.porcelain ?? "", stderr: "" };
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
    // 送信が長引く場面（回線が詰まっている）を作る
    if (pushGate) await pushGate;
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
/** 文字列なら「走っている」とその理由（`extension.ts` が渡す形） */
let busy: boolean | string;
let settings: AutoResendSettings;
let clock: number;
let afterSent: number;
let written: Map<string, string>;

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
  pushGate = undefined;
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
  vi.mocked(useLogFile).mockClear();
  // 書庫のログの置き場（Gitから外す印を置く）。書いたものを覚えておく
  written = new Map();
  workspace.fs = {
    stat: async (uri: { fsPath: string }) => {
      if (!written.has(uri.fsPath)) throw new Error("FileNotFound");
      return { type: 1 };
    },
    createDirectory: async () => undefined,
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      written.set(uri.fsPath, new TextDecoder().decode(bytes));
    },
  } as unknown as typeof workspace.fs;
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

  /**
   * 書庫の同期の記録は、先頭の作品ではなく書庫のログへ（作者の裁定、
   * 2026-10-03。設計書5.7.9）。書庫の直下のログはGitから外す印と一緒に置く
   */
  test("送り直しの記録は、先頭の作品ではなく書庫のログへ書く", async () => {
    await makeResender().attempt("interval");
    expect(vi.mocked(useLogFile).mock.calls.map((call) => call[0])).toEqual([
      library,
    ]);
    const ignore = [...written.entries()].find(([key]) =>
      key.replace(/\\/g, "/").endsWith("書庫/.aiwriter/logs/.gitignore")
    );
    expect(ignore?.[1]).toBe("*\n");
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

describe("送り直しの最中に同期が押されたら（逆向きの排他）", () => {
  const tick = () => new Promise((done) => setTimeout(done, 10));

  /**
   * `extension.ts` のコマンドの入口と同じ順：**先に「同期中」と数えてから**
   * 送り直しを待ち、それから本体を走らせる
   */
  async function runSyncCommand(
    resender: AutoResender,
    body: () => Promise<void>,
    limitMs?: number
  ): Promise<string> {
    busy = true;
    try {
      const waited = await resender.whenIdle(limitMs);
      await body();
      return waited;
    } finally {
      busy = false;
    }
  }

  function gate(): () => void {
    let release: () => void = () => undefined;
    pushGate = new Promise<void>((done) => {
      release = done;
    });
    return () => release();
  }

  test("試行が終わるのを待ってから始め、待つあいだは窓でなくステータスバーで言う", async () => {
    repo.online = true;
    const release = gate();
    const resender = makeResender();
    const order: string[] = [];

    const attempt = resender.attempt("interval").then(() => {
      order.push("送り直し");
    });
    await tick();
    expect(pushes()).toHaveLength(1);

    const command = runSyncCommand(resender, async () => {
      order.push("同期");
    });
    await tick();
    // まだ送り直しが終わっていないので、同期は始まっていない
    expect(order).toEqual([]);
    expect(statusBarMessages.map((one) => one.text).join("\n")).toContain(
      "送れていなかった分を送っています"
    );
    expect(windowsShown).toEqual([]);

    release();
    expect(await command).toBe("waited");
    await attempt;
    expect(order).toEqual(["送り直し", "同期"]);
  });

  test("上限を超えたら待つのをやめて始め、ログに1行残す", async () => {
    // 返ってこない送信（回線が詰まっている）
    pushGate = new Promise<void>(() => undefined);
    const resender = makeResender();
    void resender.attempt("interval");
    await tick();

    let started = false;
    const waited = await runSyncCommand(
      resender,
      async () => {
        started = true;
      },
      30
    );
    expect(waited).toBe("timeout");
    expect(started).toBe(true);
    expect(windowsShown).toEqual([]);
    expect(vi.mocked(logFailure).mock.calls.map((call) => call[0])).toContain(
      "自動の送り直しを待ちきれず、同期を先に始めた"
    );
  });

  test("上限は30秒", () => {
    expect(WAIT_LIMIT_MS).toBe(30_000);
  });

  test("試行が走っていなければ待たず、何も出さない", async () => {
    const resender = makeResender();
    expect(await resender.whenIdle()).toBe("idle");
    expect(statusBarMessages).toEqual([]);
  });

  test("同期が待っているあいだは、送り直しの次の試行を始めない", async () => {
    repo.online = true;
    const release = gate();
    const resender = makeResender();
    const first = resender.attempt("interval");
    await tick();

    const command = runSyncCommand(resender, async () => {
      // 同期の本体が走っている最中に鼓動が来ても、試さない
      clock += 60 * 60_000;
      expect(await resender.attempt("interval")).toBeUndefined();
    });
    release();
    await first;
    await command;
    expect(pushes()).toHaveLength(1);
  });
});

/**
 * 2026-10-11、作者のノートPC（0.103.0）。Wi-Fi を切って「すべて同期」→ 送信だけ
 * 失敗 → Wi-Fi を入れて20分たっても送られず、**送り直しの行がログに1行も
 * 無かった**。書庫には自動で書かれる執筆量の記録（stats）の未記録の変更が
 * 残っていた。
 *
 * 原因は「点検が走っている」旗の立ちっぱなし（`handoffStartupNoWait.test.ts`）。
 * ここでは、**控えているあいだも黙らない**ことと、未記録の変更が送り直しを
 * 止めないことを確かめる。
 */
describe("見送るときは黙らない（2026-10-11 の再現）", () => {
  const holdLines = (): string[] =>
    vi
      .mocked(logStep)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.includes("自動の送り直しを見送った"));

  test("同期中の旗が立ったままなら、見送った理由を1回だけログに残す", async () => {
    busy = "開いたときの点検が終わっていない";
    const resender = makeResender();
    await resender.heartbeat();
    clock += 5 * 60_000;
    await resender.heartbeat();
    clock += 5 * 60_000;
    await resender.onFocus();
    expect(calls).toEqual([]);
    expect(holdLines()).toHaveLength(1);
    expect(holdLines()[0]).toContain("開いたときの点検が終わっていない");
    expect(windowsShown).toEqual([]);

    // 旗が降りれば、次の鼓動で試す（回線が無ければ失敗を1行）
    busy = false;
    clock += 60_000;
    await resender.heartbeat();
    expect(pushes()).toHaveLength(1);
    expect(logFailure).toHaveBeenCalledTimes(1);

    // 回線が戻れば送る
    repo.online = true;
    clock += 5 * 60_000;
    const sent = await resender.heartbeat();
    expect(sent?.sent).toEqual([{ label: "書庫", ahead: 2 }]);
  });

  test("見張りの取り込み・送信が終わらないときも、理由を1回だけ残す", async () => {
    operating = true;
    const resender = makeResender();
    await resender.attempt("interval");
    await resender.attempt("focus");
    expect(calls).toEqual([]);
    expect(holdLines()).toHaveLength(1);
    expect(holdLines()[0]).toContain("取り込み・送信");
  });

  test("送るものが無ければ、走っていても何も残さない（毎分の鼓動でログを埋めない）", async () => {
    cached = new Map(works.map((work) => [work.id, tracked(0, 0)]));
    busy = "同期の操作が走っている";
    await makeResender().heartbeat();
    expect(holdLines()).toEqual([]);
  });

  test("分かれていて送れないときも、理由を1回だけ残す", async () => {
    cached = new Map(works.map((work) => [work.id, tracked(3, 2)]));
    const resender = makeResender();
    await resender.attempt("interval");
    clock += 5 * 60_000;
    await resender.attempt("interval");
    expect(calls).toEqual([]);
    expect(holdLines()).toHaveLength(1);
    expect(holdLines()[0]).toContain("書庫");
  });

  test("執筆量の記録（stats）が未記録でも、記録済みの分は送る", async () => {
    repo.online = true;
    repo.ahead = 1;
    repo.porcelain =
      " M たゆたう鉛_確認用/.aiwriter/stats/hisa-22a8.json\n" +
      "?? 事実の照合台_確認用/.aiwriter/stats/\n";
    cached = new Map(
      works.map((work) => [work.id, { ...tracked(0, 1), dirty: 2, dirtyHere: 1 }])
    );
    const result = await makeResender().heartbeat();
    expect(pushes()).toEqual([["push"]]);
    expect(result?.sent).toEqual([{ label: "書庫", ahead: 1 }]);
  });
});
