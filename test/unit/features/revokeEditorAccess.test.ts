import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 編集部との連携の解除（作者の裁定、2026-10-28）。
 * 権利を外せなくても鍵は外れ、相手の名前は忘れる。解除の行は台帳に残る。
 */

const { revokeEditorAccessFlow } = await import("../../../src/features/revokeEditorAccess");
const { FileLockStore } = await import("../../../src/core/fileLockStore");
const { readSite, writeSite } = await import("../../../src/features/shareWithEditor");

const LOCKS = nodePath.join(".aiwriter", "locks", "locks.jsonl");

describe("編集部との連携を解除", () => {
  let base = "";
  let root = "";
  const warnings: string[] = [];

  const work = (): WorkEntry => ({
    id: "work_revoke",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-10-28T00:00:00.000Z",
  });

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-revoke-"));
    root = nodePath.join(base, "氷の街");
    await fsp.mkdir(root, { recursive: true });
    warnings.length = 0;

    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          size: stat.size,
        };
      },
      readFile: async (uri: { fsPath: string }) =>
        new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, bytes);
      },
      readDirectory: async () => [],
      delete: async () => undefined,
    } as unknown as typeof workspace.fs;
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async (text: string) => {
        warnings.push(text);
        return undefined;
      }),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    });

    // 編集部が 第2話〜第3話 を押さえている。相手の名前と送り先は覚えてある
    const store = new FileLockStore(work());
    await store.acquire(["本文/002.txt", "本文/003.txt"], "編集部", "editor", "校閲中");
    await writeSite(work(), {
      remoteUrl: "https://github.com/hisa/ice-editing.git",
      editorLogin: "octocat",
    });
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  const remainingEditorLocks = async () =>
    [...(await new FileLockStore(work()).load()).values()].filter(
      (lock) => lock.holderKind === "editor"
    );

  test("鍵を外し、GitHub の権利を外し、相手の名前を忘れる", async () => {
    const revoke = vi.fn(async () => ({ ok: true as const, outcome: "removed" as const }));
    const result = await revokeEditorAccessFlow(work(), {
      confirm: async () => true,
      token: async () => "token",
      revoke,
      whoAmI: async () => "作者",
    });

    expect(result).toEqual({ kind: "done", released: 2, github: "removed" });
    expect(revoke).toHaveBeenCalledWith(
      "token",
      { owner: "hisa", repo: "ice-editing" },
      "octocat"
    );
    expect(await remainingEditorLocks()).toEqual([]);
    // 解除の行が台帳に残る（作者の名で）
    const ledger = await fsp.readFile(nodePath.join(root, LOCKS), "utf8");
    expect(ledger).toContain('"kind":"release"');
    expect(ledger).toContain('"holderKind":"author"');
    // 次に渡すとき、相手の名前を訊き直す。送り先は覚えたまま
    const site = await readSite(work());
    expect(site.editorLogin).toBeUndefined();
    expect(site.remoteUrl).toBe("https://github.com/hisa/ice-editing.git");
  });

  test("**権利を外せなくても、鍵は外れる。** 手で外す案内を出す", async () => {
    const result = await revokeEditorAccessFlow(work(), {
      confirm: async () => true,
      token: async () => "token",
      revoke: async () => ({ ok: false, reason: "noPermission", detail: "権限がありません" }),
      whoAmI: async () => "作者",
    });

    expect(result).toEqual({ kind: "done", released: 2, github: "failed" });
    expect(await remainingEditorLocks()).toEqual([]);
    expect(warnings.join("\n")).toContain("手で外してください");
    expect((await readSite(work())).editorLogin).toBeUndefined();
  });

  test("GitHub の鍵が取れなくても、鍵は外れる", async () => {
    const revoke = vi.fn();
    const result = await revokeEditorAccessFlow(work(), {
      confirm: async () => true,
      token: async () => undefined,
      revoke,
      whoAmI: async () => "作者",
    });
    expect(result.kind === "done" && result.github).toBe("failed");
    expect(revoke).not.toHaveBeenCalled();
    expect(await remainingEditorLocks()).toEqual([]);
  });

  test("確認で取りやめたら、何も変えない", async () => {
    const result = await revokeEditorAccessFlow(work(), {
      confirm: async () => false,
      token: async () => "token",
      whoAmI: async () => "作者",
    });
    expect(result).toEqual({ kind: "cancelled" });
    expect(await remainingEditorLocks()).toHaveLength(2);
    expect((await readSite(work())).editorLogin).toBe("octocat");
  });

  test("まだ渡していない作品では、解除するものが無いと言う", async () => {
    await fsp.rm(nodePath.join(root, ".aiwriter", "editing.json"));
    const result = await revokeEditorAccessFlow(work(), { confirm: async () => true });
    expect(result).toEqual({ kind: "notShared" });
  });

  test("確認の文に、範囲と相手の名前と、提案を返せなくなることを書く", async () => {
    let seen: { range: string | undefined; login: string | undefined } | undefined;
    await revokeEditorAccessFlow(work(), {
      confirm: async (summary) => {
        seen = summary;
        return false;
      },
    });
    expect(seen).toEqual({ range: "第2話〜第3話", login: "octocat" });
  });
});
