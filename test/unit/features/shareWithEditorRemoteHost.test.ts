import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, workspace } from "../support/vscodeStub";

/*
  鍵を覚えさせる口と取り寄せる口は差し替えて、呼ばれたかだけを見る
  （本物を呼ぶと、資格情報マネージャーへ作り物の鍵が入り、外のホストへ git が出ていく）
*/
const calls = vi.hoisted(() => ({ remember: [] as string[], clone: [] as string[] }));
vi.mock("../../../src/core/gitSetup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/gitSetup")>();
  return {
    ...actual,
    rememberGithubCredential: async (_token: string, url: string) => {
      calls.remember.push(url);
      return true;
    },
    ghAvailable: async () => false,
  };
});
vi.mock("../../../src/core/gitClone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/gitClone")>();
  return {
    ...actual,
    cloneRepository: async (url: string) => {
      calls.clone.push(url);
      return { ok: false, detail: "試験では取り寄せない" };
    },
  };
});

const { cloneWithCredential } = await import("../../../src/features/shareWithEditor");

/**
 * 別の機械で渡した編集用リポジトリを取り寄せるとき、送り先の URL は同期される
 * `.aiwriter/editing.json` から来る（セキュリティ点検 2026-11-21）。
 * **鍵を渡すなら github.com に限り、記録の文字列ではなく組み直した URL を使う。**
 */
let base: string;
beforeEach(async () => {
  base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "share-remote-"));
  calls.remember.length = 0;
  calls.clone.length = 0;
  workspace.fs = {
    createDirectory: async (uri: { fsPath: string }) => {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    stat: async (uri: { fsPath: string }) => {
      const stat = await fsp.stat(uri.fsPath);
      return { type: stat.isDirectory() ? FileType.Directory : FileType.File, size: stat.size };
    },
    delete: async (uri: { fsPath: string }, options?: { recursive?: boolean }) => {
      await fsp.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: true });
    },
  } as unknown as typeof workspace.fs;
});
afterEach(async () => {
  workspace.fs = {} as typeof workspace.fs;
  await fsp.rm(base, { recursive: true, force: true });
});

describe("編集用リポジトリの取り寄せの送り先", () => {
  test("github.com 以外なら、鍵を覚えさせず取り寄せもせずに止める", async () => {
    const result = await cloneWithCredential(
      "dummy-token-123456",
      "https://github.com@evil.example/a/b.git",
      nodePath.join(base, "x-editing")
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.detail).toContain("github.com");
    expect(calls.remember).toEqual([]);
    expect(calls.clone).toEqual([]);
  });

  test("github.com なら、組み直した URL で覚えさせて取り寄せる", async () => {
    await cloneWithCredential(
      "dummy-token-123456",
      "  https://github.com/nonahisa/novel-editing/  ",
      nodePath.join(base, "x-editing")
    );
    expect(calls.remember).toEqual(["https://github.com/nonahisa/novel-editing.git"]);
    expect(calls.clone).toEqual(["https://github.com/nonahisa/novel-editing.git"]);
  });
});
