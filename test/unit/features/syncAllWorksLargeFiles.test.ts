import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

vi.mock("../../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/logger")>()),
  logFailure: vi.fn(),
  logStep: vi.fn(),
}));
// 同期のログは作品のフォルダーへ書かれる（書くと書庫が「未記録」になる）。ここでは向けない
vi.mock("../../../src/features/syncLog", () => ({ useSyncLog: async () => undefined }));

import { syncAllWorks } from "../../../src/features/syncAllWorks";
import { headCommit, isGitAvailable, runGit } from "../../../src/core/git";
import { GITHUB_FILE_LIMIT_BYTES } from "../../../src/core/gitLargeFiles";
import { globalPushRejections } from "../../../src/features/pushRejectionMemory";
import { IGNORE_LARGE_FILES_LABEL } from "../../../src/features/largeFilesIgnore";
import { setFileReaderForTests } from "../../../src/core/fileRead";
import { logFailure } from "../../../src/core/logger";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { window, workspace } from "../support/vscodeStub";
import { ALLOW_BARE } from "../support/gitTemplate";

/**
 * GitHub に送れない大きさのファイルと、送信を断られたときの知らせ（設計書5.5.21）。
 *
 * 2026-11-14 の作者の実機：書庫に 722MB の zip・380MB の onnx が入った記録ができ、送信が
 * GitHub に断られていた。報告には「記録できませんでした」の下に LF→CRLF の warning が並び、
 * 本当の理由が読めなかった。
 *
 * **本物の git で確かめる。** 送り先は一時フォルダーの bare リポジトリ（GitHub の代わり）。
 * 断る送り先は pre-receive のフックで作る。大きいファイルは中身を書かずに大きさだけ伸ばす。
 */

const gitReady = await isGitAvailable();
const tempRoots: string[] = [];

/** 出た知らせ（本文・detail・ボタン） */
let shown: Array<{ message: string; buttons: string[] }>;
/** 報告の窓で押すボタン（無ければ押さない） */
let press: string | undefined;

async function git(cwd: string, ...args: string[]): Promise<string> {
  // 裸の置き場（送り先）の中でも打てるように（git 2.56 の既定。support/gitTemplate.ts の ALLOW_BARE）
  const result = await runGit([...ALLOW_BARE, ...args], cwd, 60_000);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} が失敗: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/** 書庫（1作品）と送り先を作り、最初の記録を送っておく */
async function makeLibrary(options: { rejectingHook?: boolean } = {}): Promise<{
  root: string;
  remote: string;
  work: WorkEntry;
}> {
  // 長い名前に直してから使う。GitHub の Windows の機械では一時フォルダーが短い名前
  // （C:\Users\RUNNER~1\…）で渡り、製品は git の返す長い名前の置き場で送り直しの覚えを
  // 付けるので、短い名前のままでは覚えを引けずに落ちた（2026-11-15。手元は短い名前が無く通っていた）
  const base = realpathSync.native(await fs.mkdtemp(nodePath.join(os.tmpdir(), "syncB_")));
  tempRoots.push(base);
  const remote = nodePath.join(base, "remote.git");
  const root = nodePath.join(base, "書庫");
  await fs.mkdir(root, { recursive: true });
  await git(base, "init", "--bare", "-b", "main", remote);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "作者");
  await git(root, "config", "user.email", "author@example.com");
  // 作者の機械と同じく改行を変換する（記録のたびに LF→CRLF の warning が出る）
  await git(root, "config", "core.autocrlf", "true");
  const folder = nodePath.join(root, "確認用コピー");
  await fs.mkdir(nodePath.join(folder, "本文"), { recursive: true });
  await fs.writeFile(nodePath.join(folder, "本文", "001.txt"), "一行目\n二行目\n");
  // 作者が書いた .gitignore（末尾に改行なし・CRLF）。足したあとも先頭にそのまま残ること
  await fs.writeFile(nodePath.join(root, ".gitignore"), "# 作者の除外\r\n*.tmp");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "最初の記録");
  await git(root, "remote", "add", "origin", remote);
  await git(root, "push", "-u", "origin", "main");
  if (options.rejectingHook) {
    // GitHub の断り方を写す。warning を先に出して、理由が埋もれる形にする
    await fs.writeFile(
      nodePath.join(remote, "hooks", "pre-receive"),
      [
        "#!/bin/sh",
        "echo \"warning: in the working copy of '確認用コピー/本文/001.txt', LF will be replaced by CRLF the next time Git touches it\" >&2",
        "echo \"error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.\" >&2",
        "echo \"error: File 素材/big.zip is 722.00 MB; this exceeds GitHub's file size limit of 100.00 MB\" >&2",
        "exit 1",
        "",
      ].join("\n")
    );
    // **実行できる印を付ける。** Mac・Linux の git は実行できないフックを黙って飛ばすので、
    // 付けないと断られずに通り、この試しが落ちた（2026-11-18 Mac の全件）。Windows は印を見ない
    await fs.chmod(nodePath.join(remote, "hooks", "pre-receive"), 0o755);
  }
  const work = { id: "w1", title: "確認用コピー", folderPath: folder } as WorkEntry;
  return { root, remote, work };
}

/** 中身を書かずに大きさだけのファイルを作る */
async function sparse(file: string, size: number): Promise<void> {
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  const handle = await fs.open(file, "w");
  await handle.truncate(size);
  await handle.close();
}

function depsFor(work: WorkEntry) {
  return {
    registry: { list: () => [work] } as unknown as WorkRegistry,
    monitor: { refreshAll: async () => undefined } as unknown as GitSyncMonitorLike,
    run: runGit,
    autoResend: true,
  };
}

const allText = (): string => shown.map((one) => one.message).join("\n");

beforeEach(() => {
  shown = [];
  press = undefined;
  // 大きさは本物のディスクで測る（試験の既定の読み口は VS Code の代役）
  setFileReaderForTests(undefined);
  vi.mocked(logFailure).mockClear();
  Object.assign(workspace, {
    fs: {
      // .gitignore へ足したあとの読み直し（`appendMissingIgnoreRules`）は本物のディスクを読む
      readFile: async (uri: { fsPath: string }) => new Uint8Array(await fs.readFile(uri.fsPath)),
      stat: async (uri: { fsPath: string }) => {
        const stat = await fs.stat(uri.fsPath);
        return { type: stat.isDirectory() ? 2 : 1, size: stat.size, mtime: 0, ctime: 0 };
      },
      createDirectory: async () => undefined,
      writeFile: async () => undefined,
    },
  });
  const record = (message: string, rest: unknown[]) => {
    const detail = rest.find(
      (item): item is { detail?: string } =>
        typeof item === "object" && item !== null && "detail" in item
    )?.detail;
    const buttons = rest.filter((item): item is string => typeof item === "string");
    shown.push({ message: detail ? `${message}\n${detail}` : message, buttons });
    return buttons;
  };
  Object.assign(window, {
    withProgress: (
      _options: unknown,
      task: (
        progress: { report(value: { message?: string }): void },
        token: { isCancellationRequested: boolean }
      ) => unknown
    ) => Promise.resolve(task({ report: () => undefined }, { isCancellationRequested: false })),
    showInformationMessage: async (message: string, ...rest: unknown[]) => {
      const buttons = record(message, rest);
      return buttons.includes("同期する") ? "同期する" : undefined;
    },
    showWarningMessage: async (message: string, ...rest: unknown[]) => {
      const buttons = record(message, rest);
      return press && buttons.includes(press) ? press : undefined;
    },
  });
});

afterEach(() => {
  setFileReaderForTests(undefined);
});

afterAll(async () => {
  for (const base of tempRoots) {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("(a) 100MB を超えるファイルは、記録の前に止めて知らせる", () => {
  test.skipIf(!gitReady)(
    "記録も送信もせず、道と大きさと［.gitignore に足す］が出る。押すと末尾に足され、もう一度で通る",
    async () => {
      const { root, remote, work } = await makeLibrary();
      const headBefore = await git(root, "rev-parse", "HEAD");
      await fs.writeFile(nodePath.join(work.folderPath, "本文", "001.txt"), "一行目\n書き足した\n");
      const bigName = "確認用コピー/素材/大きい [版].zip";
      await sparse(nodePath.join(root, bigName), GITHUB_FILE_LIMIT_BYTES + 1024 * 1024);

      press = IGNORE_LARGE_FILES_LABEL;
      await syncAllWorks(depsFor(work));

      // 記録されていない（HEAD は動かず、送り先も同じ）
      expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
      expect(await git(remote, "rev-parse", "main")).toBe(headBefore);
      const report = shown.find((one) => one.buttons.includes(IGNORE_LARGE_FILES_LABEL));
      expect(report?.message).toContain("記録も送信もしませんでした");
      expect(report?.message).toContain(`・${bigName}（101.0MB）`);

      // 押したので、作者の行はそのまま、末尾に1行だけ足された
      const ignore = await fs.readFile(nodePath.join(root, ".gitignore"), "utf8");
      expect(ignore).toBe("# 作者の除外\r\n*.tmp\r\n/確認用コピー/素材/大きい \\[版\\].zip\r\n");
      // ファイルは動かさない・消さない
      expect((await fs.stat(nodePath.join(root, bigName))).size).toBe(
        GITHUB_FILE_LIMIT_BYTES + 1024 * 1024
      );

      // もう一度同期すると、大きいファイルを除いて記録され、送られる
      shown = [];
      press = undefined;
      await syncAllWorks(depsFor(work));
      expect(await git(root, "rev-parse", "HEAD")).not.toBe(headBefore);
      expect(await git(remote, "rev-parse", "main")).toBe(await git(root, "rev-parse", "HEAD"));
      const sent = await git(remote, "ls-tree", "-r", "--name-only", "main");
      expect(sent).toContain(".gitignore");
      expect(sent).not.toContain("大きい");
      expect(allText()).not.toContain("最後まで通りませんでした");
    },
    120_000
  );

  test.skipIf(!gitReady)(
    "押さなければ .gitignore は変わらない",
    async () => {
      const { root, work } = await makeLibrary();
      await sparse(nodePath.join(root, "確認用コピー", "model.onnx"), GITHUB_FILE_LIMIT_BYTES + 1);
      await syncAllWorks(depsFor(work));
      expect(await fs.readFile(nodePath.join(root, ".gitignore"), "utf8")).toBe(
        "# 作者の除外\r\n*.tmp"
      );
      expect(allText()).toContain("・確認用コピー/model.onnx（100.0MB）");
    },
    120_000
  );
});

describe("(a) すでに記録してしまった大きいファイルは、送る前に止める（作者の書庫がいまこの形）", () => {
  test.skipIf(!gitReady)(
    "送り先は動かず、道と大きさが出る。.gitignore のボタンは出さず、送り直しの覚えに入る",
    async () => {
      const { root, remote, work } = await makeLibrary();
      const sentBefore = await git(remote, "rev-parse", "main");
      // 製品を通さずに、大きいファイルの入った記録を作っておく（ahead 1）
      const bigName = "確認用コピー/素材/大きい [版].zip";
      await sparse(nodePath.join(root, bigName), GITHUB_FILE_LIMIT_BYTES + 1024 * 1024);
      await git(root, "add", "-A");
      await git(root, "commit", "-m", "大きいファイルを入れてしまった記録");

      await syncAllWorks(depsFor(work));

      expect(await git(remote, "rev-parse", "main")).toBe(sentBefore);
      const text = allText();
      expect(text).toContain("まだ送っていない記録に");
      expect(text).toContain(`・${bigName}（101.0MB）`);
      expect(shown.flatMap((one) => one.buttons)).not.toContain(IGNORE_LARGE_FILES_LABEL);
      expect(globalPushRejections.rejectedReason(root, await headCommit(root))).toContain(
        "大きい [版].zip"
      );
    },
    120_000
  );
});

describe("(b) 断られたときは、断りの文を理由にする", () => {
  test.skipIf(!gitReady)(
    "warning が先に出ても、知らせの理由は断りの文。ログには全文を残す",
    async () => {
      const { root, work } = await makeLibrary({ rejectingHook: true });
      await fs.writeFile(nodePath.join(work.folderPath, "本文", "001.txt"), "一行目\n書き足した\n");

      await syncAllWorks(depsFor(work));

      const text = allText();
      expect(text).toContain("GitHub に送るのを断られました。");
      expect(text).toContain("GH001: Large files detected.");
      expect(text).toContain("this exceeds GitHub's file size limit of 100.00 MB");
      expect(text).toContain("[remote rejected]");
      expect(text).not.toContain("LF will be replaced");
      // 断られたのに「ネットにつながったら自動で送ります」とは言わない
      expect(text).not.toContain("ネットにつながったら");

      const logged = vi
        .mocked(logFailure)
        .mock.calls.find(([context]) => context === "すべて同期：送信を断られた");
      expect(String(logged?.[1].詳細)).toContain("LF will be replaced");

      // 自動の送り直しが同じ記録で試し直さないよう、覚えている
      expect(globalPushRejections.rejectedReason(root, await headCommit(root))).toContain(
        "GH001"
      );
    },
    120_000
  );
});
