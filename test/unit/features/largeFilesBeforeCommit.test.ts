import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/logger")>()),
  logFailure: vi.fn(),
  logStep: vi.fn(),
}));
// 作品のフォルダーは在るものとして扱う（無いときの決まりは *MissingWork.test.ts が見る）
vi.mock("../../../src/core/workFolderPresence", () => ({
  isWorkFolderPresent: async () => true,
  findMissingWorks: async () => [],
}));

import * as vscode from "vscode";
import type { GitCommandRunner } from "../../../src/core/git";
import { GITHUB_FILE_LIMIT_BYTES } from "../../../src/core/gitLargeFiles";
import { fileReader, setFileReaderForTests, type FileReader } from "../../../src/core/fileRead";
import { logFailure } from "../../../src/core/logger";
import { buildSyncTarget } from "../../../src/core/syncTarget";
import { recordChanges, runSetupStep } from "../../../src/features/gitOnboarding";
import { restoreFromHistory } from "../../../src/features/gitRestore";
import { foldDivergence } from "../../../src/features/resolveDivergence";
import { setUpAndPush } from "../../../src/features/shareWithEditor";
import { IGNORE_LARGE_FILES_LABEL } from "../../../src/features/largeFilesIgnore";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { WorkEntry } from "../../../src/models/types";
import { workspace } from "../support/vscodeStub";

/**
 * GitHub に送れない大きさのファイルがあれば、**どの記録の道でも**記録しない（設計書5.5.21）。
 *
 * 「すべて同期」と単独の同期の「取り込む前の記録」だけが見ていて、変更の記録・最初の記録・
 * 復元・分岐を合わせる前の自動保存・編集部へ渡す記録は、`git add -A` のまま 100MB を超える
 * ファイルを記録に入れていた。記録してから GitHub に断られると、作者の手では戻しにくい。
 *
 * 偽の git は、`status --porcelain -z --untracked-files=all` に大きなファイルを返す。
 * 大きさは読み手の `stat` だけを差し替えて渡す。
 */

const root = "C:/書庫";
const work = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/書庫/いじめられっ子",
  registeredAt: "2026-10-01T00:00:00.000Z",
} as WorkEntry;
const BIG = "いじめられっ子/素材/big.zip";
const FIELD = "\u001f";

/** 出た知らせ（本文・ボタン） */
let shown: Array<{ message: string; buttons: string[] }>;
/** 記録の状態の答え（`-z` の形）。既定はまだ git に入っていない大きなファイル */
let zStatus: string;
let calls: string[][];

const original = {
  warning: vscode.window.showWarningMessage,
  info: vscode.window.showInformationMessage,
  error: vscode.window.showErrorMessage,
  quickPick: vscode.window.showQuickPick,
  fs: workspace.fs,
};

function record(message: string, rest: unknown[]): string | undefined {
  const buttons = rest.filter((item): item is string => typeof item === "string");
  shown.push({ message, buttons });
  // 確認の窓（モーダル）は先頭のボタンを押した体にする。知らせのボタンは押さない
  const modal = rest.some(
    (item) => typeof item === "object" && item !== null && "modal" in item
  );
  return modal ? buttons[0] : undefined;
}

const run: GitCommandRunner = async (args) => {
  calls.push(args);
  const joined = args.join(" ");
  if (joined === "status --porcelain -z --untracked-files=all") {
    return { code: 0, stdout: zStatus, stderr: "" };
  }
  if (joined.startsWith("status --porcelain")) {
    return { code: 0, stdout: zStatus.split("\u0000").join("\n"), stderr: "" };
  }
  if (args[0] === "--version") return { code: 0, stdout: "git version 2.51", stderr: "" };
  if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: root, stderr: "" };
  if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
    return { code: 0, stdout: `true\n${root}`, stderr: "" };
  }
  if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
  if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
  if (joined.startsWith("rev-parse --abbrev-ref")) {
    return { code: 0, stdout: "origin/main", stderr: "" };
  }
  if (args[0] === "rev-list") return { code: 0, stdout: "0\t1", stderr: "" };
  if (joined.startsWith("rev-parse -q --verify")) return { code: 1, stdout: "", stderr: "" };
  if (args[0] === "config") return { code: 0, stdout: "作者", stderr: "" };
  if (args[0] === "log") {
    return {
      code: 0,
      stdout: [
        ["b".repeat(40), "bbbbbbb", "2026-11-15 10:00", "今の記録"].join(FIELD),
        ["a".repeat(40), "aaaaaaa", "2026-11-14 10:00", "前の記録"].join(FIELD),
      ].join("\n"),
      stderr: "",
    };
  }
  if (joined.startsWith("diff --name-status")) {
    return { code: 0, stdout: "M\u0000いじめられっ子/a.txt\u0000", stderr: "" };
  }
  // 差がある（記録するものがある）と答える
  if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

const committed = () => calls.some((args) => args[0] === "commit");
const added = () => calls.some((args) => args[0] === "add");
const largeNotices = () => shown.filter((one) => one.message.includes("100MB超"));

beforeEach(async () => {
  shown = [];
  calls = [];
  zStatus = `?? ${BIG}\u0000 M いじめられっ子/a.txt\u0000`;
  vi.mocked(logFailure).mockClear();
  const w = vscode.window as unknown as Record<string, unknown>;
  w.showWarningMessage = async (message: string, ...rest: unknown[]) => record(message, rest);
  w.showInformationMessage = async (message: string, ...rest: unknown[]) => record(message, rest);
  w.showErrorMessage = async (message: string, ...rest: unknown[]) => record(message, rest);
  // 復元の版の選択：いちばん上（前の記録）を選ぶ
  w.showQuickPick = async (items: unknown) => (items as unknown[])[0];
  // `.git` は無い（編集用フォルダーは初回の共有）
  workspace.fs = {
    stat: async () => {
      throw Object.assign(new Error("無い"), { code: "FileNotFound" });
    },
  } as unknown as typeof workspace.fs;
  // **本物の読み手を包み、stat だけ差し替える**（ほかの読み取りは本物のまま）
  setFileReaderForTests(undefined);
  const real = await fileReader();
  const wrapped = Object.create(real) as FileReader;
  wrapped.stat = async (absolutePath: string) =>
    absolutePath.replace(/\\/g, "/").endsWith("素材/big.zip")
      ? { type: "file", size: GITHUB_FILE_LIMIT_BYTES + 1024 * 1024, mtime: 0 }
      : real.stat(absolutePath);
  setFileReaderForTests(wrapped);
});

afterEach(() => {
  const w = vscode.window as unknown as Record<string, unknown>;
  w.showWarningMessage = original.warning;
  w.showInformationMessage = original.info;
  w.showErrorMessage = original.error;
  w.showQuickPick = original.quickPick;
  workspace.fs = original.fs;
  setFileReaderForTests(undefined);
});

const target = () => buildSyncTarget(root, [work]);

describe("記録の前に、GitHub に送れない大きさのファイルを見る", () => {
  test("変更の記録：記録せず、道と大きさを知らせ、［.gitignore に足す］を出す", async () => {
    const ok = await recordChanges(target(), run);
    expect(ok).toBe(false);
    expect(added()).toBe(false);
    expect(committed()).toBe(false);
    expect(largeNotices()).toHaveLength(1);
    expect(largeNotices()[0].message).toContain(BIG);
    expect(largeNotices()[0].buttons).toContain(IGNORE_LARGE_FILES_LABEL);
    expect(vi.mocked(logFailure)).toHaveBeenCalled();
  });

  test("変更の記録：記録済みのファイルが大きくなったときは、ボタンを出さない", async () => {
    zStatus = ` M ${BIG}\u0000`;
    await recordChanges(target(), run);
    expect(committed()).toBe(false);
    expect(largeNotices()).toHaveLength(1);
    expect(largeNotices()[0].buttons).not.toContain(IGNORE_LARGE_FILES_LABEL);
  });

  test("Gitで管理を始める（初回コミット）：初期化のあと、記録しない", async () => {
    const ok = await runSetupStep(target(), { kind: "not_a_repo" }, run);
    expect(ok).toBe(false);
    expect(calls.some((args) => args[0] === "init")).toBe(true);
    expect(committed()).toBe(false);
    expect(largeNotices()).toHaveLength(1);
    expect(largeNotices()[0].buttons).toContain(IGNORE_LARGE_FILES_LABEL);
  });

  test("大きなファイルが無ければ、変更の記録は今までどおり記録する", async () => {
    zStatus = " M いじめられっ子/a.txt\u0000";
    await recordChanges(target(), run);
    expect(committed()).toBe(true);
    expect(largeNotices()).toEqual([]);
  });

  test("復元：原稿を戻す前に止め、1回目の自動保存も戻す操作もしない", async () => {
    await restoreFromHistory(work, { works: [work], run });
    expect(committed()).toBe(false);
    expect(calls.some((args) => args[0] === "checkout")).toBe(false);
    expect(largeNotices()).toHaveLength(1);
    expect(largeNotices()[0].message).toContain("過去の版へは戻していません");
    expect(shown.some((one) => one.message.includes("版に戻しました"))).toBe(false);
  });

  test("分岐を合わせる前の自動保存：記録も控えのブランチも作らず、理由を返す", async () => {
    const result = await foldDivergence(
      { registry: { list: () => [work] } as unknown as WorkRegistry, run },
      { root, label: "書庫", upstream: "origin/main" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("100MB超");
    expect(result.reason).toContain(BIG);
    expect(committed()).toBe(false);
    expect(calls.some((args) => args[0] === "branch")).toBe(false);
    expect(calls.some((args) => args[0] === "merge")).toBe(false);
    expect(vi.mocked(logFailure)).toHaveBeenCalled();
    // まだ git に入っていないファイルは、失敗の窓の［.gitignore に足す］へ渡す
    expect(result.tooLarge?.root).toBe(root);
    expect(result.tooLarge?.files.map((one) => one.path)).toEqual([BIG]);
  });

  test("分岐を合わせる前：記録済みのファイルが大きくなっただけなら、足す先を渡さない", async () => {
    zStatus = ` M ${BIG}\u0000`;
    const result = await foldDivergence(
      { registry: { list: () => [work] } as unknown as WorkRegistry, run },
      { root, label: "書庫", upstream: "origin/main" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(BIG);
    expect(result.tooLarge).toBeUndefined();
    expect(committed()).toBe(false);
  });

  test("編集部へ渡す：記録も送信もせず、理由を返す（送り直しの合わせ直しへ回さない印つき）", async () => {
    const result = await setUpAndPush(work, "C:/編集者/いじめられっ子-編集用", { run });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("100MB超");
    expect(result.tooLarge).toBe(true);
    expect(committed()).toBe(false);
    expect(calls.some((args) => args[0] === "push")).toBe(false);
  });
});
