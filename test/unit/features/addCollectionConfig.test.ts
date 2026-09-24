import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, FileType, window, workspace } from "../support/vscodeStub";
import { registerAll } from "../../../src/features/addCollection";
import { WorkRegistry, readWorkConfig } from "../../../src/core/workRegistry";
import { readWorkKind, writeWorkKind } from "../../../src/core/workKindStore";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 書庫の道で登録した作品に、設定ファイル（`.aiwriter/config.json`）ができるか
 * （2026-09-24、ブラウザ版の実機確認で見つけた件）。
 *
 * ## 起きたこと
 *
 * `npm run test:web` の VS Code（`@vscode/test-web`）で、書庫の道
 * （「1件の作品が見つかりました。登録するものを選んでください」）から
 * 作品を登録した。後日サーバーを立て直してから「作品の種類」を押すと、
 * 「作品の設定ファイル（.aiwriter/config.json）が見つかりません」で止まり、
 * 作品フォルダーには `.gitignore` だけがあった。
 *
 * ## 分かったこと
 *
 * **製品の不具合ではなく、test-web の置き場の性質だった。** test-web が
 * 手元のフォルダーを見せる口（`fs-provider` の `MemFileSystemProvider`）は、
 * 読むときだけサーバーへ取りに行き、**書いたものはブラウザのメモリの中の
 * 表に置くだけ**である。画面を読み込み直すと、書いたものは全部消える。
 *
 * それでも `.gitignore` だけがあったのは、**起動のたびに整備
 * （`maintainWorks`）が「無ければ作る」から**である。設定ファイルは起動では
 * 作り直さないので、消えたまま残る。登録簿（globalState）はブラウザの
 * 保存領域に残るので、「登録済みなのに設定ファイルが無い」形になる。
 *
 * ここでは本物のディスクの上で、次の3つを確かめる。
 *
 * 1. 書庫の道の登録（`registerAll` → `addExisting`）は設定ファイルを作る
 * 2. その作品の種類は変えられる（実機で落ちた操作そのもの）
 * 3. 書いたものが消えたあと起動の整備を通すと、`.gitignore` だけが戻る
 *    ——実機で見た形がこの筋書きで説明できること
 */

let base: string;

/** 本物のディスクへそのまま流す `workspace.fs`（`aiInstructions.test.ts` と同じ形） */
function installDiskFileSystem(): void {
  workspace.fs = {
    createDirectory: async (uri: { fsPath: string }) => {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    stat: async (uri: { fsPath: string }) => {
      try {
        const stat = await fsp.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      } catch {
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      }
    },
    readFile: async (uri: { fsPath: string }) => {
      try {
        return new Uint8Array(await fsp.readFile(uri.fsPath));
      } catch {
        // **本物と同じ形で断る**（素の ENOENT では見分けが効かない経路がある）
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      }
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await fsp.writeFile(uri.fsPath, bytes);
    },
    readDirectory: async (uri: { fsPath: string }) => {
      const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [
        entry.name,
        entry.isDirectory() ? FileType.Directory : FileType.File,
      ]);
    },
    delete: async (uri: { fsPath: string }, options?: { recursive?: boolean }) => {
      await fsp.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: true });
    },
    rename: async (
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      if (!options?.overwrite) {
        const exists = await fsp
          .stat(to.fsPath)
          .then(() => true)
          .catch(() => false);
        if (exists) throw new FileSystemError(to.fsPath, "FileExists");
      }
      await fsp.rename(from.fsPath, to.fsPath);
    },
  } as unknown as typeof workspace.fs;
}

/** 登録簿の中身を持つだけの `globalState`（`workRegistryDuplicate.test.ts` と同じ形） */
function fakeContext(): { globalState: unknown } {
  let stored: WorkEntry[] = [];
  return {
    globalState: {
      get: <T>(_key: string, _defaultValue: T): T => stored as unknown as T,
      update: async (_key: string, value: unknown) => {
        stored = value as WorkEntry[];
      },
    },
  };
}

const originalInfo = window.showInformationMessage;

beforeEach(async () => {
  base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-collection-"));
  // 書庫の中に、本文1つだけの作品（実機で使ったのと同じ形）
  await fsp.mkdir(nodePath.join(base, "仮作品"), { recursive: true });
  await fsp.writeFile(
    nodePath.join(base, "仮作品", "episode_0001.txt"),
    "書き出しの一文です。",
    "utf8"
  );
  installDiskFileSystem();
});

afterEach(async () => {
  workspace.fs = {} as typeof workspace.fs;
  window.showInformationMessage = originalInfo;
  await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
});

async function registerFromCollection(): Promise<{
  registry: WorkRegistry;
  entry: WorkEntry;
}> {
  const registry = new WorkRegistry(fakeContext() as never);
  const added = await registerAll(registry, [
    {
      folderPath: nodePath.join(base, "仮作品"),
      title: "仮作品",
      hasConfig: false,
      alreadyRegistered: false,
    },
  ]);
  expect(added).toHaveLength(1);
  return { registry, entry: added[0] };
}

describe("書庫の道で登録した作品の設定ファイル", () => {
  test("登録すると .aiwriter/config.json ができる", async () => {
    const { entry } = await registerFromCollection();

    const onDisk = JSON.parse(
      await fsp.readFile(
        nodePath.join(base, "仮作品", ".aiwriter", "config.json"),
        "utf8"
      )
    ) as { workTitle?: string };
    expect(onDisk.workTitle).toBe("仮作品");
    expect(await readWorkConfig(entry)).toBeDefined();
  });

  test("登録した作品の種類を変えられる（実機で止まった操作）", async () => {
    const { entry } = await registerFromCollection();

    await writeWorkKind(entry, "essay");

    expect((await readWorkConfig(entry))?.kind).toBe("essay");
    expect(await readWorkKind(entry)).toBe("essay");
  });

  test("書いたものが消えたあと起動の整備を通すと、.gitignore だけが戻る（test-web で見た形）", async () => {
    const { registry, entry } = await registerFromCollection();

    // test-web の置き場は、読み込み直すと書いたものを全部失う。
    // 本文（サーバーから読むもの）は残り、拡張機能が書いたものだけが消える
    await fsp.rm(nodePath.join(base, "仮作品", ".aiwriter"), {
      recursive: true,
      force: true,
    });
    await fsp.rm(nodePath.join(base, "仮作品", ".gitignore"), { force: true });

    await registry.maintainWorks();

    const names = (await fsp.readdir(nodePath.join(base, "仮作品"))).sort();
    expect(names).toEqual([".gitignore", "episode_0001.txt"]);
    expect(await readWorkConfig(entry)).toBeUndefined();
  });
});
