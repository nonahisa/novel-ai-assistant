import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";
import type { GitCommandResult } from "../../../src/core/git";

/**
 * 話を開くたびに、編集者の鍵の台帳を取りに行く（作者の裁定 2026-11-07。設計書5.7.5.2）。
 *
 * 2026-11-07 の作者の実機：kmizu さんが範囲を選んだあと、作者の手元の台帳には鍵がまだ
 * 届いていなかった（取り込みは同期のときだけ）。そのため原稿エディターで打った字が
 * そのまま原稿へ入った。
 *
 * - 取りに行くのは鍵の台帳だけ。**本文には触らない**（`pull`・`reset` を走らせない）
 * - 取りに行くのは、渡していて（editorLogin がある）解除していない作品だけ。
 *   ブラウザ版・編集者モードでは行かない。同じ作品は5分あける
 *
 * 本物のファイルシステムで走らせる（`editingLocks.test.ts` と同じ理由）。
 */

const { refreshEditorLocksQuietly } = await import("../../../src/features/shareWithEditor");
const { createLockRefresher } = await import("../../../src/features/editorLockRefresh");
const { editorLockOf, onLockLedgerWritten } = await import("../../../src/core/fileLockStore");
const { LOCK_REFRESH_INTERVAL_MS } = await import("../../../src/core/lockRefreshPolicy");

const LOCKS = nodePath.join(".aiwriter", "locks", "locks.jsonl");
const POINTER = nodePath.join(".aiwriter", "cache", "editing.json");

function lockLine(kind: "acquire" | "release", file: string, time: string): string {
  return JSON.stringify({ kind, file, holder: "Kei Mizushima", holderKind: "editor", time, note: "" });
}

describe("話を開いたときに鍵を取りに行く", () => {
  let base = "";
  let root = "";
  let editing = "";

  const work = (): WorkEntry => ({
    id: "work_refresh",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-11-07T00:00:00.000Z",
  });
  const put = async (dir: string, relative: string, text: string) => {
    const target = nodePath.join(dir, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-lockrefresh-"));
    root = nodePath.join(base, "氷の街");
    editing = nodePath.join(base, "編集用");
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(editing, { recursive: true });
    await put(root, POINTER, JSON.stringify({ folderPath: editing }));
    await put(root, nodePath.join("本文", "002.txt"), "作者の本文");
    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return { type: stat.isDirectory() ? FileType.Directory : FileType.File, size: stat.size };
      },
      readFile: async (uri: { fsPath: string }) => new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, bytes);
      },
    } as unknown as typeof workspace.fs;
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    });
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  /** 偽の git。`fetch` は通し、`show @{u}:…` は GitHub 側の台帳を返す */
  function fakeGit(upstreamLocks: string, fetchOk = true) {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<GitCommandResult> => {
      calls.push(args);
      if (args[0] === "fetch") {
        return fetchOk
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 128, stdout: "", stderr: "fatal: unable to access" };
      }
      if (args[0] === "show" && args[1] === "@{u}:.aiwriter/locks/locks.jsonl") {
        return { code: 0, stdout: upstreamLocks, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "想定していない命令" };
    };
    return { run, calls };
  }

  const episode = () => nodePath.join(root, "本文", "002.txt");

  test("鍵が届く前は書ける。取りに行くと鍵が入り、止まる", async () => {
    // 今の動き：手元の台帳に鍵が無いので、校閲中の話が書けてしまう
    expect(await editorLockOf(work(), episode())).toBeUndefined();

    const git = fakeGit(`${lockLine("acquire", "本文/002.txt", "2026-11-07T09:30:00.000Z")}\n`);
    const result = await refreshEditorLocksQuietly(work(), git.run);

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.locksAcquired).toEqual(["本文/002.txt"]);
    expect((await editorLockOf(work(), episode()))?.holderKind).toBe("editor");
    // 本文には触らない（作業木を動かす命令を走らせない）
    expect(git.calls.map((args) => args[0])).toEqual(["fetch", "show"]);
    expect(await fsp.readFile(episode(), "utf8")).toBe("作者の本文");
  });

  test("鍵が外れた行も届く", async () => {
    await put(root, LOCKS, `${lockLine("acquire", "本文/002.txt", "2026-11-07T09:30:00.000Z")}\n`);
    const git = fakeGit(
      [
        lockLine("acquire", "本文/002.txt", "2026-11-07T09:30:00.000Z"),
        lockLine("release", "本文/002.txt", "2026-11-07T12:00:00.000Z"),
      ].join("\n") + "\n"
    );
    const result = await refreshEditorLocksQuietly(work(), git.run);
    if (result.status !== "done") throw new Error("取りに行けていない");
    expect(result.locksReleased).toEqual(["本文/002.txt"]);
    expect(await editorLockOf(work(), episode())).toBeUndefined();
  });

  test("回線が無ければ手元の台帳のまま（投げない）", async () => {
    const git = fakeGit(`${lockLine("acquire", "本文/002.txt", "2026-11-07T09:30:00.000Z")}\n`, false);
    const result = await refreshEditorLocksQuietly(work(), git.run);
    expect(result.status).toBe("fetchFailed");
    expect(await editorLockOf(work(), episode())).toBeUndefined();
    expect(git.calls.map((args) => args[0])).toEqual(["fetch"]);
  });

  test("鍵が入ると、台帳を見ている相手（開いている面）へ知らせる", async () => {
    const heard: string[] = [];
    const listening = onLockLedgerWritten((target) => heard.push(target.id));
    try {
      const git = fakeGit(`${lockLine("acquire", "本文/002.txt", "2026-11-07T09:30:00.000Z")}\n`);
      await refreshEditorLocksQuietly(work(), git.run);
      expect(heard).toEqual(["work_refresh"]);
      // 同じ中身をもう一度取りに行っても、台帳は変わらないので知らせない
      await refreshEditorLocksQuietly(work(), git.run);
      expect(heard).toEqual(["work_refresh"]);
    } finally {
      listening.dispose();
    }
  });

  test("渡していない作品は、置き場の覚えが無いので git を走らせない", async () => {
    await fsp.rm(nodePath.join(root, POINTER));
    const git = fakeGit("");
    expect((await refreshEditorLocksQuietly(work(), git.run)).status).toBe("noPointer");
    expect(git.calls).toEqual([]);
  });
});

describe("取りに行く作品の条件と間", () => {
  const work: WorkEntry = {
    id: "work_policy",
    title: "氷の街",
    folderPath: "C:/作品/氷の街",
    registeredAt: "2026-11-07T00:00:00.000Z",
  };

  function refresher(overrides: {
    editorLogin?: string;
    editorMode?: boolean;
    canRunProcesses?: boolean;
  } = {}) {
    let now = Date.parse("2026-11-07T09:30:00.000Z");
    const fetchLocks = vi.fn(async () => undefined);
    const refresh = createLockRefresher({
      now: () => now,
      editorMode: () => overrides.editorMode ?? false,
      canRunProcesses: () => overrides.canRunProcesses ?? true,
      editorLogin: async () => ("editorLogin" in overrides ? overrides.editorLogin : "kmizu"),
      fetchLocks,
    });
    return {
      refresh,
      fetchLocks,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  test("渡していて解除していない作品へ取りに行く", async () => {
    const r = refresher();
    expect(await r.refresh(work)).toEqual({ go: true });
    expect(r.fetchLocks).toHaveBeenCalledTimes(1);
  });

  test("渡していない・解除した作品（editorLogin が無い）へは行かない", async () => {
    const r = refresher({ editorLogin: undefined });
    expect(await r.refresh(work)).toEqual({ go: false, reason: "notShared" });
    expect(r.fetchLocks).not.toHaveBeenCalled();
  });

  test("ブラウザ版では行かない", async () => {
    const r = refresher({ canRunProcesses: false });
    expect(await r.refresh(work)).toEqual({ go: false, reason: "browser" });
    expect(r.fetchLocks).not.toHaveBeenCalled();
  });

  test("編集者モードでは行かない（鍵を掛ける側）", async () => {
    const r = refresher({ editorMode: true });
    expect(await r.refresh(work)).toEqual({ go: false, reason: "editorMode" });
    expect(r.fetchLocks).not.toHaveBeenCalled();
  });

  test("5分の間は2回目を取りに行かない。過ぎたらまた行く", async () => {
    const r = refresher();
    await r.refresh(work);
    r.advance(LOCK_REFRESH_INTERVAL_MS - 1);
    expect(await r.refresh(work)).toEqual({ go: false, reason: "tooSoon" });
    expect(r.fetchLocks).toHaveBeenCalledTimes(1);
    r.advance(1);
    expect(await r.refresh(work)).toEqual({ go: true });
    expect(r.fetchLocks).toHaveBeenCalledTimes(2);
  });

  test("取りに行って失敗しても、間は空ける（回線が無いと開くたびに待たされる）", async () => {
    const r = refresher();
    r.fetchLocks.mockRejectedValueOnce(new Error("回線が無い"));
    expect(await r.refresh(work)).toEqual({ go: true });
    expect(await r.refresh(work)).toEqual({ go: false, reason: "tooSoon" });
  });
});
