import { beforeEach, describe, expect, test } from "vitest";
import { syncAllWorks } from "../../../src/features/syncAllWorks";
import type { GitCommandResult, GitCommandRunner } from "../../../src/core/git";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { FileType, window, workspace } from "../support/vscodeStub";
import { setFallbackLogRoot, settleLogWrites, useLogFile } from "../../../src/core/logger";

/**
 * 登録済みの作品のフォルダーが無い置き場は、「すべて同期」で記録も取り込みも送信もしない
 * （設計書5.5.14。2026-11-14 の作者の実データ）。
 *
 * 書庫（1つの git に18作品）から2作品のフォルダーを別の場所へ移したあと「すべて同期」を
 * 押すと、(1) 無くなった作品のフォルダーへ同期のログを書き（親フォルダーごと作り直した）、
 * (2) 移した2作品の削除を「65件の執筆」として確認なしで記録・送信した。
 *
 * 作品のフォルダーが丸ごと消えて見えるのは、消した・移したときだけでなく、OneDrive の
 * 移動・外付けドライブが外れた・クラウドの取り寄せ中もある。だから**その置き場は止めて
 * 知らせ、ほかの置き場は続ける。**
 *
 * git は作り物。**無いフォルダーを cwd にした git は起動に失敗する**（本物と同じ形にする。
 * 作り物が cwd を見ないと、無い作品が書庫に束ねられて見え、本物で起きる分かれ方を隠す）。
 */

const library = "C:/書庫";
const single = "C:/単独/月の庭";

const present: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/書庫/いじめられっ子",
} as WorkEntry;
const moved: WorkEntry = {
  id: "w2",
  title: "たゆたう鉛",
  folderPath: "C:/書庫/たゆたう鉛",
} as WorkEntry;
const alone: WorkEntry = {
  id: "w3",
  title: "月の庭",
  folderPath: single,
} as WorkEntry;

let works: WorkEntry[] = [];
const registry = { list: () => works } as unknown as WorkRegistry;
const monitor = { refreshAll: async () => undefined } as unknown as GitSyncMonitorLike;

/** フォルダーが在る場所（区切りと大小を揃えた鍵） */
let folders: Set<string>;
/** 書き込まれたファイル → 中身 */
let disk: Map<string, string>;
const norm = (key: string) => key.replace(/\\/g, "/").toLowerCase();

/** 呼ばれた git（副コマンドと cwd） */
let calls: Array<{ args: string[]; cwd: string }> = [];
/** 出た知らせ（本文とボタン） */
let shown: Array<{ message: string; buttons: string[] }> = [];

function inside(cwd: string, root: string): boolean {
  const key = norm(cwd);
  const base = norm(root);
  return key === base || key.startsWith(`${base}/`);
}

/**
 * 記録するもの・取り込むもの・送るものが全部ある置き場の git。
 * 書庫の変わった道には、移した作品の削除も入る（実データと同じ形）
 */
function busy(root: string, pendingZ: string): (args: string[]) => GitCommandResult {
  return (args) => {
    const joined = args.join(" ");
    if (args[0] === "--version") return { code: 0, stdout: "git version 2.51", stderr: "" };
    if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
      return { code: 0, stdout: `true\n${root}`, stderr: "" };
    }
    if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: root, stderr: "" };
    if (joined === "status --porcelain --untracked-files=all") {
      return { code: 0, stdout: " M a.txt\n D b.txt\n", stderr: "" };
    }
    if (joined === "status --porcelain -z --untracked-files=all") {
      return { code: 0, stdout: pendingZ, stderr: "" };
    }
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (joined.startsWith("diff --name-only -z")) return { code: 0, stdout: "", stderr: "" };
    if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
    if (joined.startsWith("rev-parse --abbrev-ref")) {
      return { code: 0, stdout: "origin/main", stderr: "" };
    }
    if (args[0] === "rev-list") return { code: 0, stdout: "1\t1", stderr: "" };
    if (args[0] === "config") return { code: 0, stdout: "作者", stderr: "" };
    if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

const libraryRepo = busy(
  library,
  " M いじめられっ子/本文/001.txt\u0000 D たゆたう鉛/本文/001.txt\u0000"
);
const singleRepo = busy(single, " M 本文/001.txt\u0000");

const run: GitCommandRunner = async (args, cwd) => {
  calls.push({ args, cwd });
  // 無いフォルダーでは git が起動できない（本物の `runGit` は失敗の形で返す）
  if (!folders.has(norm(cwd))) {
    return { code: -1, stdout: "", stderr: "spawn ENOENT" };
  }
  if (inside(cwd, single)) return singleRepo(args);
  if (inside(cwd, library)) return libraryRepo(args);
  return { code: 128, stdout: "", stderr: "not a git repository" };
};

/** その置き場で、書き換える git（記録・取り込み・送信）が呼ばれたか */
function wroteIn(root: string): string[] {
  return calls
    .filter(({ cwd }) => inside(cwd, root))
    .map(({ args }) => args[0])
    .filter((name) => ["add", "commit", "pull", "push", "merge", "stash"].includes(name));
}

const logOf = (folder: string) =>
  [...disk.entries()].find(([key]) =>
    key.endsWith(`${norm(folder)}/.aiwriter/logs/actions.log`)
  )?.[1];

beforeEach(() => {
  calls = [];
  shown = [];
  disk = new Map();
  folders = new Set([library, present.folderPath, single].map(norm));
  setFallbackLogRoot("");
  useLogFile(undefined);

  Object.assign(workspace, {
    fs: {
      stat: async (uri: { fsPath: string }) => {
        if (!folders.has(norm(uri.fsPath))) throw Object.assign(new Error("無い"), { code: "FileNotFound" });
        return { type: FileType.Directory, size: 0, mtime: 0, ctime: 0 };
      },
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const found = disk.get(norm(uri.fsPath));
        if (found === undefined) throw new Error("まだ無い");
        return new TextEncoder().encode(found);
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(norm(uri.fsPath), new TextDecoder().decode(bytes));
      },
    },
  });
  Object.assign(window, {
    withProgress: (
      _options: unknown,
      task: (
        progress: { report(value: { message?: string }): void },
        token: { isCancellationRequested: boolean }
      ) => unknown
    ) => Promise.resolve(task({ report: () => undefined }, { isCancellationRequested: false })),
    showInformationMessage: async (message: string, ...rest: unknown[]) => {
      const detail = rest.find(
        (item): item is { detail?: string } =>
          typeof item === "object" && item !== null && "detail" in item
      )?.detail;
      const buttons = rest.filter((item): item is string => typeof item === "string");
      shown.push({ message: detail ? `${message}\n${detail}` : message, buttons });
      return buttons.includes("同期する") ? "同期する" : undefined;
    },
    showWarningMessage: async (message: string, ...rest: unknown[]) => {
      shown.push({
        message,
        buttons: rest.filter((item): item is string => typeof item === "string"),
      });
      return undefined;
    },
  });
});

describe("フォルダーが無い作品を含む置き場は、すべて同期で止める", () => {
  for (const [name, order] of [
    ["無い作品が登録の後ろ", () => [present, moved, alone]],
    ["無い作品が登録の先頭", () => [moved, present, alone]],
  ] as const) {
    test(`${name}：書庫は記録も取り込みも送信もせず、ほかの置き場は同期する`, async () => {
      works = order();
      await syncAllWorks({ registry, monitor, run, autoResend: false });

      expect(wroteIn(library)).toEqual([]);
      // ほかの置き場は今までどおり 記録 → 取り込み → 送信
      expect(wroteIn(single)).toEqual(expect.arrayContaining(["add", "commit", "pull", "push"]));
    });

    test(`${name}：無い作品のフォルダーへログを書かない`, async () => {
      works = order();
      await syncAllWorks({ registry, monitor, run, autoResend: false });
      await settleLogWrites();

      expect(logOf(moved.folderPath)).toBeUndefined();
      const underMoved = [...disk.keys()].filter((key) => key.startsWith(norm(moved.folderPath)));
      expect(underMoved).toEqual([]);
    });

    test(`${name}：報告に作品名入りの知らせと、登録を外すボタンが出る`, async () => {
      works = order();
      await syncAllWorks({ registry, monitor, run, autoResend: false });

      const text = shown.map((one) => one.message).join("\n");
      expect(text).toContain(
        "作品のフォルダーが見つからないので、この置き場は同期を止めました：たゆたう鉛。"
      );
      expect(text).toContain("作品の一覧から外してから同期してください");
      // git が無いとは言わない（無いフォルダーで git が起動できなかっただけ）
      expect(text).not.toContain("gitが見つかりません");
      expect(text).not.toContain("Gitで管理していません");
      const buttons = shown.flatMap((one) => one.buttons);
      expect(buttons).toContain("「たゆたう鉛」の登録を解除");
    });
  }

  test("確認の窓でも、止める置き場と作品名を先に見せる", async () => {
    works = [present, moved, alone];
    await syncAllWorks({ registry, monitor, run, autoResend: false });

    const confirm = shown.find((one) => one.buttons.includes("同期する"));
    expect(confirm?.message).toContain(
      "作品のフォルダーが見つからないので、この置き場は同期しません：たゆたう鉛。"
    );
  });

  test("止めた置き場しか無いときは「同期するものはありませんでした」で始めない", async () => {
    works = [present, moved];
    await syncAllWorks({ registry, monitor, run, autoResend: false });

    expect(wroteIn(library)).toEqual([]);
    const notice = shown.find((one) => one.message.includes("たゆたう鉛"));
    expect(notice?.message.startsWith("同期するものはありませんでした")).toBe(false);
    expect(notice?.buttons).toContain("「たゆたう鉛」の登録を解除");
  });

  test("作品が全部そろっている書庫は、今までどおり記録・送信する", async () => {
    folders.add(norm(moved.folderPath));
    works = [present, moved, alone];
    await syncAllWorks({ registry, monitor, run, autoResend: false });

    expect(wroteIn(library)).toEqual(expect.arrayContaining(["add", "commit", "pull", "push"]));
    const text = shown.map((one) => one.message).join("\n");
    expect(text).not.toContain("作品のフォルダーが見つからない");
  });

  test("編集者モード（受け取るだけ）でも、無い作品のある置き場は受け取らない", async () => {
    works = [present, moved];
    await syncAllWorks({ registry, monitor, run, autoResend: false, editor: true });

    expect(wroteIn(library)).toEqual([]);
    const text = shown.map((one) => one.message).join("\n");
    expect(text).toContain("作品のフォルダーが見つからないので");
  });
});
