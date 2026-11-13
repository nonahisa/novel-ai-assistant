import * as vscode from "vscode";
import type { GitCommandRunner } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";
import { FileType, workspace } from "./vscodeStub";

/**
 * 同じ置き場（書庫）に、フォルダーが見つからない作品があるときの試験の部品
 * （2026-11-14 の作者の実データ。設計書5.5.14）。
 *
 * 書庫 `C:/書庫` に2作品が登録され、「たゆたう鉛」のフォルダーだけが無い。
 * **無いフォルダーを cwd にした git は起動に失敗する**（本物の git と同じく、
 * 子プロセスが起きない）。在るフォルダーでは、記録できる変更と送れる分がある書庫として答える。
 */

export const library = "C:/書庫";
export const present = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/書庫/いじめられっ子",
  registeredAt: "2026-10-01T00:00:00.000Z",
} as WorkEntry;
export const moved = {
  id: "w2",
  title: "たゆたう鉛",
  folderPath: "C:/書庫/たゆたう鉛",
  registeredAt: "2026-10-01T00:00:00.000Z",
} as WorkEntry;

export const norm = (key: string) => key.replace(/\\/g, "/").toLowerCase();

export interface MissingWorkHarness {
  /** 在るフォルダー（`norm` した形） */
  folders: Set<string>;
  /** 呼ばれた git（副コマンドの並び） */
  calls: string[][];
  /** 出た警告の知らせ */
  warned: Array<{ message: string; buttons: string[] }>;
  /** 遅れ・進みの数（`rev-list` の答え） */
  counts: { behind: number; ahead: number };
  /** 記録していない変更（`status --porcelain` の答え） */
  porcelain: string;
  run: GitCommandRunner;
  registry: {
    list: () => WorkEntry[];
    get: (id: string) => WorkEntry | undefined;
    onDidChange: () => { dispose: () => void };
  };
  /** 作品が全部そろった形にする */
  bringBack(): void;
  /** 書き込み（記録・取り込み・送信・合流・控えの枝・初期化・書き戻し）の git だけ */
  writes(): string[][];
  /** 「作品のフォルダーが見つからない」の知らせ */
  missingNotices(): Array<{ message: string; buttons: string[] }>;
  restore(): void;
}

const WRITE_COMMANDS = ["add", "commit", "pull", "merge", "branch", "push", "init", "checkout", "restore", "rm", "stash"];

/** 試験ごとに作り直す（`beforeEach` で呼び、`afterEach` で `restore`） */
export function setUpMissingWork(): MissingWorkHarness {
  const originalWarning = vscode.window.showWarningMessage;
  const originalFs = workspace.fs;
  const harness: MissingWorkHarness = {
    folders: new Set([library, present.folderPath].map(norm)),
    calls: [],
    warned: [],
    counts: { behind: 0, ahead: 1 },
    porcelain: " M いじめられっ子/a.txt\n D たゆたう鉛/b.txt\n",
    run: async (args, cwd) => {
      harness.calls.push(args);
      // 無いフォルダーでは子プロセスが起きない（作業場所が無い）
      if (!harness.folders.has(norm(cwd))) {
        return { code: -1, stdout: "", stderr: `spawn git ENOENT (cwd: ${cwd})` };
      }
      const joined = args.join(" ");
      if (args[0] === "--version") return { code: 0, stdout: "git version 2.51", stderr: "" };
      if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: library, stderr: "" };
      if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
        return { code: 0, stdout: `true\n${library}`, stderr: "" };
      }
      if (joined.startsWith("status --porcelain")) {
        return { code: 0, stdout: harness.porcelain, stderr: "" };
      }
      if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
      if (joined.startsWith("rev-parse --abbrev-ref")) {
        return { code: 0, stdout: "origin/main", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return {
          code: 0,
          stdout: `${harness.counts.behind}\t${harness.counts.ahead}`,
          stderr: "",
        };
      }
      if (joined.startsWith("rev-parse -q --verify")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "config") return { code: 0, stdout: "作者", stderr: "" };
      if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    registry: {
      list: () => [present, moved],
      get: (id: string) => [present, moved].find((work) => work.id === id),
      onDidChange: () => ({ dispose: () => undefined }),
    },
    bringBack() {
      harness.folders.add(norm(moved.folderPath));
    },
    writes() {
      return harness.calls.filter((args) => WRITE_COMMANDS.includes(args[0]));
    },
    missingNotices() {
      return harness.warned.filter((one) => one.message.includes("作品のフォルダーが見つからない"));
    },
    restore() {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
      Object.assign(workspace, { fs: originalFs });
    },
  };
  Object.assign(workspace, {
    fs: {
      stat: async (uri: { fsPath: string }) => {
        if (!harness.folders.has(norm(uri.fsPath))) {
          throw Object.assign(new Error("無い"), { code: "FileNotFound" });
        }
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
    harness.warned.push({
      message,
      buttons: rest.filter((item): item is string => typeof item === "string"),
    });
    return undefined;
  };
  return harness;
}

/** 知らせの文（「すべて同期」の `work_missing` と同じ） */
export const STOPPED_LINE =
  "作品のフォルダーが見つからないので、この置き場は同期を止めました：たゆたう鉛。";
export const UNREGISTER_BUTTON = "「たゆたう鉛」の登録を解除";
