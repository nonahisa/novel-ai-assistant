import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as vscode from "vscode";
import type { GitCommandRunner } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";
import { FileType, workspace } from "../support/vscodeStub";
import { GitSyncMonitor } from "../../../src/features/gitSync";
import { recordChanges } from "../../../src/features/gitOnboarding";
import { buildSyncTarget } from "../../../src/core/syncTarget";

/**
 * 作品1つの同期でも、同じ置き場（書庫）にフォルダーが無い作品があれば記録しない
 * （2026-11-14 の作者の実データ。「すべて同期」と同じ決まり。設計書5.5.14）。
 *
 * 取り込みの前の記録（［記録してから取り込む］）と、分かれた分を合わせる前の記録は
 * `git add -A` で置き場ぜんぶを入れる。押した作品が在っても、移した作品の削除まで記録される。
 */

const library = "C:/書庫";
const present = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/書庫/いじめられっ子",
  registeredAt: "2026-10-01T00:00:00.000Z",
} as WorkEntry;
const moved = {
  id: "w2",
  title: "たゆたう鉛",
  folderPath: "C:/書庫/たゆたう鉛",
  registeredAt: "2026-10-01T00:00:00.000Z",
} as WorkEntry;

const norm = (key: string) => key.replace(/\\/g, "/").toLowerCase();
let folders: Set<string>;
let calls: string[][] = [];
let warned: Array<{ message: string; buttons: string[] }> = [];
const originalWarning = vscode.window.showWarningMessage;

const registry = {
  list: () => [present, moved],
  get: (id: string) => [present, moved].find((work) => work.id === id),
  onDidChange: () => ({ dispose: () => undefined }),
};

/** 記録できるものがある書庫。どの問いにも答える */
const run: GitCommandRunner = async (args) => {
  calls.push(args);
  const joined = args.join(" ");
  if (args[0] === "--version") return { code: 0, stdout: "git version 2.51", stderr: "" };
  if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: library, stderr: "" };
  if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
    return { code: 0, stdout: `true\n${library}`, stderr: "" };
  }
  if (joined.startsWith("status --porcelain")) {
    return { code: 0, stdout: " M いじめられっ子/a.txt\n D たゆたう鉛/b.txt\n", stderr: "" };
  }
  if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
  if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
  if (joined.startsWith("rev-parse --abbrev-ref")) {
    return { code: 0, stdout: "origin/main", stderr: "" };
  }
  if (args[0] === "rev-list") return { code: 0, stdout: "0\t0", stderr: "" };
  if (args[0] === "config") return { code: 0, stdout: "作者", stderr: "" };
  if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

beforeEach(() => {
  calls = [];
  warned = [];
  folders = new Set([library, present.folderPath].map(norm));
  Object.assign(workspace, {
    fs: {
      stat: async (uri: { fsPath: string }) => {
        if (!folders.has(norm(uri.fsPath))) throw Object.assign(new Error("無い"), { code: "FileNotFound" });
        return { type: FileType.Directory, size: 0, mtime: 0, ctime: 0 };
      },
      createDirectory: async () => undefined,
      readFile: async () => {
        throw new Error("まだ無い");
      },
      writeFile: async () => undefined,
    },
  });
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async (
    message: string,
    ...rest: unknown[]
  ) => {
    warned.push({
      message,
      buttons: rest.filter((item): item is string => typeof item === "string"),
    });
    return undefined;
  };
});

afterEach(() => {
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
});

type Private = {
  recordBeforePull(work: WorkEntry): Promise<boolean>;
  foldDiverged(work: WorkEntry): Promise<boolean>;
};

describe("作品1つの同期で、同じ置き場にフォルダーが無い作品があるとき", () => {
  for (const step of ["recordBeforePull", "foldDiverged"] as const) {
    test(`${step}：記録せず、作品名入りの知らせと登録を外すボタンを出す`, async () => {
      const monitor = new GitSyncMonitor(registry as never, { run });
      try {
        const ok = await (monitor as unknown as Private)[step](present);
        expect(ok).toBe(false);
        const wrote = calls.filter((args) => ["add", "commit", "pull", "merge", "branch"].includes(args[0]));
        expect(wrote).toEqual([]);
        const notice = warned.find((one) => one.message.includes("作品のフォルダーが見つからない"));
        expect(notice?.message).toContain(
          "作品のフォルダーが見つからないので、この置き場は同期を止めました：たゆたう鉛。"
        );
        expect(notice?.buttons).toEqual(["「たゆたう鉛」の登録を解除"]);
      } finally {
        monitor.dispose();
      }
    });
  }

  test("作品ごとの一覧の「記録」（recordChanges）も、記録せずに知らせる", async () => {
    const ok = await recordChanges(buildSyncTarget(library, [present, moved]), run);
    expect(ok).toBe(false);
    expect(calls.filter((args) => ["add", "commit"].includes(args[0]))).toEqual([]);
    const notice = warned.find((one) => one.message.includes("作品のフォルダーが見つからない"));
    expect(notice?.message).toContain(
      "作品のフォルダーが見つからないので、この置き場は同期を止めました：たゆたう鉛。"
    );
    expect(notice?.buttons).toEqual(["「たゆたう鉛」の登録を解除"]);
  });

  test("作品が全部そろっていれば、取り込みの前の記録は今までどおり進む", async () => {
    folders.add(norm(moved.folderPath));
    const monitor = new GitSyncMonitor(registry as never, { run });
    try {
      await (monitor as unknown as Private).recordBeforePull(present);
      expect(calls.some((args) => args[0] === "add")).toBe(true);
      expect(warned.some((one) => one.message.includes("作品のフォルダーが見つからない"))).toBe(false);
    } finally {
      monitor.dispose();
    }
  });
});
