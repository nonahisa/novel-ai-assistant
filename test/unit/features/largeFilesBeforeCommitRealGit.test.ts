import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

vi.mock("../../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/logger")>()),
  logFailure: vi.fn(),
  logStep: vi.fn(),
}));
vi.mock("../../../src/features/syncLog", () => ({ useSyncLog: async () => undefined }));
vi.mock("../../../src/core/workFolderPresence", () => ({
  isWorkFolderPresent: async () => true,
  findMissingWorks: async () => [],
}));

import * as vscode from "vscode";
import { isGitAvailable, runGit } from "../../../src/core/git";
import { GITHUB_FILE_LIMIT_BYTES } from "../../../src/core/gitLargeFiles";
import { setFileReaderForTests } from "../../../src/core/fileRead";
import { logFailure } from "../../../src/core/logger";
import { buildSyncTarget } from "../../../src/core/syncTarget";
import { recordChanges, runSetupStep } from "../../../src/features/gitOnboarding";
import { IGNORE_LARGE_FILES_LABEL } from "../../../src/features/largeFilesIgnore";
import type { WorkEntry } from "../../../src/models/types";
import { FileSystemError, workspace } from "../support/vscodeStub";

/**
 * 本物の git で、101MB のファイルがある置き場の「Gitで管理を始める」（初回コミット）と
 * 「変更の記録」を通す（設計書5.5.21）。
 *
 * **ふだんの check では走らせない**（`NOVELAI_REAL_GIT_LARGE=1` のときだけ）。中身を書かずに
 * 大きさだけ伸ばすので速いが、検査が壊れていると git が 101MB を読んで記録に入れる。
 */
const enabled = process.env.NOVELAI_REAL_GIT_LARGE === "1" && (await isGitAvailable());

let base: string;
let root: string;
let work: WorkEntry;
let shown: string[];
const originalWarning = vscode.window.showWarningMessage;
const originalQuickPick = vscode.window.showQuickPick;
const originalFs = workspace.fs;

async function git(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
  const result = await runGit(args, cwd, 60_000);
  return { code: result.code, stdout: result.stdout.trim() };
}

beforeEach(async () => {
  shown = [];
  setFileReaderForTests(undefined);
  // .gitignore を作る・足す・読み直す（`appendMissingIgnoreRules`）は本物のディスクで行う。
  // 置き場に .gitignore がまだ無い（Gitで管理を始めた直後）ので、作る道も本物にする
  Object.assign(workspace, {
    fs: {
      // 無いときは VS Code と同じ形（FileNotFound）で投げる。新規作成の道はこの形で「無い」と読む
      readFile: async (uri: { fsPath: string }) => {
        try {
          return new Uint8Array(await fs.readFile(uri.fsPath));
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") {
            throw new FileSystemError("無い", "FileNotFound");
          }
          throw error;
        }
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fs.stat(uri.fsPath);
        return { type: stat.isDirectory() ? 2 : 1, size: stat.size, mtime: 0, ctime: 0 };
      },
      createDirectory: async (uri: { fsPath: string }) => {
        await fs.mkdir(uri.fsPath, { recursive: true });
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fs.writeFile(uri.fsPath, bytes);
      },
      rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
        await fs.rename(from.fsPath, to.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        await fs.rm(uri.fsPath, { recursive: true, force: true });
      },
    },
  });
  base = realpathSync.native(await fs.mkdtemp(nodePath.join(os.tmpdir(), "impl111_")));
  root = nodePath.join(base, "作品");
  await fs.mkdir(nodePath.join(root, "本文"), { recursive: true });
  await fs.writeFile(nodePath.join(root, "本文", "001.txt"), "一行目\n");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "作者");
  await git(root, "config", "user.email", "author@example.com");
  // 中身を書かずに大きさだけのファイル（101MB）
  const big = nodePath.join(root, "素材", "big.zip");
  await fs.mkdir(nodePath.dirname(big), { recursive: true });
  await fs.writeFile(big, "");
  await fs.truncate(big, GITHUB_FILE_LIMIT_BYTES + 1024 * 1024);
  work = { id: "w1", title: "作品", folderPath: root, registeredAt: "2026-11-16T00:00:00.000Z" };
  // 確認（「始める」）は選ぶ窓で出る。押す項目を選んだ体にする
  (vscode.window as unknown as Record<string, unknown>).showQuickPick = async (items: unknown) =>
    (items as Array<{ button?: string }>).find((item) => item.button === "始める");
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = async (
    message: string,
    ...rest: unknown[]
  ) => {
    void rest;
    shown.push(message);
    // 知らせのボタンは押さない
    return undefined;
  };
});

afterEach(async () => {
  Object.assign(workspace, { fs: originalFs });
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = originalWarning;
  (vscode.window as unknown as Record<string, unknown>).showQuickPick = originalQuickPick;
  await fs.rm(base, { recursive: true, force: true });
});

describe.skipIf(!enabled)("本物の git：101MB のファイルがあると記録しない", () => {
  test("Gitで管理を始める：1つ目の記録を作らず、ファイルは残る", async () => {
    const target = buildSyncTarget(root, [work]);
    const ok = await runSetupStep(target, { kind: "not_a_repo" }, runGit);
    expect(ok).toBe(false);
    // 確認のあと、初期化までは進んだ（入口で止まっただけでは確かめたことにならない）
    expect(shown.some((one) => one.includes("100MB超"))).toBe(true);
    // 記録が1つも無い（HEAD が指す記録が無い）
    expect((await git(root, "rev-parse", "--verify", "HEAD")).code).not.toBe(0);
    expect((await git(root, "rev-list", "--all", "--count")).stdout).toBe("0");
    // ステージにも載せていない（`git add -A` の前に止めた）
    expect((await git(root, "diff", "--cached", "--name-only")).stdout).toBe("");
    const stat = await fs.stat(nodePath.join(root, "素材", "big.zip"));
    expect(stat.size).toBe(GITHUB_FILE_LIMIT_BYTES + 1024 * 1024);
    expect(shown.some((one) => one.includes("100MB超") && one.includes("素材/big.zip")), shown.join("\n---\n")).toBe(true);
  });

  test("Gitで管理を始める：［.gitignore に足す］のあとは、そのファイルを除いて1つ目の記録ができる", async () => {
    const target = buildSyncTarget(root, [work]);
    // 知らせの［.gitignore に足す］を押した体にする（押されたときに走る処理そのもの）
    (vscode.window as unknown as Record<string, unknown>).showWarningMessage = async (
      message: string,
      ...rest: unknown[]
    ) => {
      shown.push(message);
      return rest.includes(IGNORE_LARGE_FILES_LABEL) ? IGNORE_LARGE_FILES_LABEL : undefined;
    };
    expect(await runSetupStep(target, { kind: "not_a_repo" }, runGit)).toBe(false);
    // ボタンの処理は答えを待たずに後から走るので、.gitignore ができるまで待つ
    const gitignore = nodePath.join(root, ".gitignore");
    for (let i = 0; i < 50; i++) {
      const text = await fs.readFile(gitignore, "utf8").catch(() => "");
      if (text.includes("/素材/big.zip")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 作れなかったときは、落ちた理由（ログに出したもの）を見えるようにする
    const written = await fs
      .readFile(gitignore, "utf8")
      .catch(() => JSON.stringify(vi.mocked(logFailure).mock.calls));
    expect(written).toContain("/素材/big.zip");

    expect(await runSetupStep(target, { kind: "not_a_repo" }, runGit)).toBe(true);
    expect((await git(root, "rev-list", "--all", "--count")).stdout).toBe("1");
    const recorded = (await git(root, "ls-files")).stdout.split("\n");
    expect(recorded).toContain(".gitignore");
    expect(recorded.some((one) => one.includes("big.zip"))).toBe(false);
    // ファイルは動かさない・消さない
    expect((await fs.stat(nodePath.join(root, "素材", "big.zip"))).size).toBe(
      GITHUB_FILE_LIMIT_BYTES + 1024 * 1024
    );
  });

  test("変更の記録：記録済みの置き場でも記録を増やさない。外せば記録できる", async () => {
    await fs.rename(nodePath.join(root, "素材", "big.zip"), nodePath.join(base, "big.zip"));
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "最初の記録");
    await fs.rename(nodePath.join(base, "big.zip"), nodePath.join(root, "素材", "big.zip"));
    await fs.writeFile(nodePath.join(root, "本文", "002.txt"), "二話\n");

    const target = buildSyncTarget(root, [work]);
    expect(await recordChanges(target, runGit)).toBe(false);
    expect((await git(root, "rev-list", "--all", "--count")).stdout).toBe("1");
    expect(shown.some((one) => one.includes("100MB超"))).toBe(true);

    // 大きなファイルを外すと、今までどおり記録できる（検査が記録そのものを止めていない）
    await fs.rm(nodePath.join(root, "素材", "big.zip"));
    expect(await recordChanges(target, runGit)).toBe(true);
    expect((await git(root, "rev-list", "--all", "--count")).stdout).toBe("2");
  });
});
