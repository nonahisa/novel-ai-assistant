import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 編集用リポジトリを GitHub から消す（設計書5.7.5.4。作者の決定 2026-11-07）。
 *
 * - 守り：決めていない提案・編集者の校閲中の印・解除前・送り先が分からない、のときは消さずに理由を出す
 * - 消したら `.aiwriter/editing.json` の送り先（remoteUrl）**だけ**を外し、この端末の場所の覚えも消す
 *   （次の「編集者へ渡す」が新しく作る道へ進む）。手元の編集用フォルダーは消さない
 * - 本物の GitHub へはつながない（消す口と鍵は差し替える）
 */

vi.mock("../../../src/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/logger")>();
  return { ...actual, logStep: () => undefined, logFailure: () => undefined, useLogFile: () => undefined };
});

const { deleteEditingRepositoryFlow } = await import("../../../src/features/deleteEditingRepository");
const { FileLockStore } = await import("../../../src/core/fileLockStore");
const { readPointer, readSite } = await import("../../../src/features/shareWithEditor");
const { planShareSource } = await import("../../../src/core/editingRepo");

describe("編集用リポジトリを消す", () => {
  let base = "";
  let root = "";
  let folder = "";
  const warnings: string[] = [];
  const infos: string[] = [];

  const work = (): WorkEntry => ({
    id: "work_delete",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-11-07T00:00:00.000Z",
  });

  const sitePath = () => nodePath.join(root, ".aiwriter", "editing.json");
  const pointerPath = () => nodePath.join(root, ".aiwriter", "cache", "editing.json");

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-delete-repo-"));
    root = nodePath.join(base, "氷の街");
    folder = nodePath.join(base, "編集部", "氷の街-編集用");
    await fsp.mkdir(nodePath.join(root, ".aiwriter", "cache"), { recursive: true });
    await fsp.mkdir(folder, { recursive: true });
    warnings.length = 0;
    infos.length = 0;

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
      readDirectory: async () => [],
      delete: async (uri: { fsPath: string }) => {
        await fsp.rm(uri.fsPath, { force: false });
      },
    } as unknown as typeof workspace.fs;
    Object.assign(window, {
      showInformationMessage: vi.fn(async (text: string) => {
        infos.push(text);
        return undefined;
      }),
      showWarningMessage: vi.fn(async (text: string) => {
        warnings.push(text);
        return undefined;
      }),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    });

    // 解除は済んでいる（相手の名前は忘れてある）。送り先と、知らない項目が1つある
    await fsp.writeFile(
      sitePath(),
      `${JSON.stringify({ remoteUrl: "https://github.com/hisa/ice-editing.git", note: "作者のメモ" }, null, 2)}\n`
    );
    await fsp.writeFile(pointerPath(), JSON.stringify({ folderPath: folder }));
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  const allow = {
    confirm: async () => true,
    hasDeleteScope: async () => true,
    token: async () => "token",
  };

  test("消したら、editing.json の送り先だけを外し（ほかの項目は残す）、場所の覚えも消す。フォルダーは残す", async () => {
    const remove = vi.fn(async () => ({ ok: true as const }));
    const result = await deleteEditingRepositoryFlow(work(), {}, { ...allow, remove });

    expect(result).toEqual({ kind: "deleted", fullName: "hisa/ice-editing" });
    expect(remove).toHaveBeenCalledWith("token", { owner: "hisa", repo: "ice-editing" });
    const site = JSON.parse(await fsp.readFile(sitePath(), "utf8")) as Record<string, unknown>;
    expect(site).toEqual({ note: "作者のメモ" });
    expect(await readPointer(work())).toBeUndefined();
    // 次の「編集者へ渡す」は新しく作る道へ進む
    expect(
      planShareSource({ pointerFolderExists: false, rememberedRemoteUrl: (await readSite(work())).remoteUrl })
    ).toBe("create");
    // 手元の編集用フォルダーは消さず、場所を知らせる
    await expect(fsp.stat(folder)).resolves.toBeTruthy();
    expect(infos.join("\n")).toContain(folder);
  });

  test("決めていない提案が残っていれば、消さずに理由を出す", async () => {
    const { ProposalStore } = await import("../../../src/core/proposalStore");
    // 提案の台帳が未決の1件を返す（台帳の行の形は提案の試験が見ている。ここは守りだけを見る）
    const remove = vi.fn();
    const pendingCount = vi.spyOn(ProposalStore.prototype, "load").mockResolvedValue([
      { status: "pending" } as never,
    ]);
    try {
      const result = await deleteEditingRepositoryFlow(work(), {}, { ...allow, remove });
      expect(result).toEqual({ kind: "blocked", reason: "pending" });
    } finally {
      pendingCount.mockRestore();
    }
    expect(remove).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("まだ決めていない編集者の提案が 1 件");
    expect((await readSite(work())).remoteUrl).toBe("https://github.com/hisa/ice-editing.git");
  });

  test("編集者の校閲中の印が残っていれば、消さない", async () => {
    await new FileLockStore(work()).acquire(["本文/002.txt"], "編集部", "editor", "校閲中");
    const remove = vi.fn();
    const result = await deleteEditingRepositoryFlow(work(), {}, { ...allow, remove });
    expect(result).toEqual({ kind: "blocked", reason: "locks" });
    expect(remove).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("校閲中の印が残っています");
  });

  test("解除がまだ（相手の名前が残っている）なら、消さない", async () => {
    await fsp.writeFile(
      sitePath(),
      JSON.stringify({ remoteUrl: "https://github.com/hisa/ice-editing.git", editorLogin: "octocat" })
    );
    const remove = vi.fn();
    const result = await deleteEditingRepositoryFlow(work(), {}, { ...allow, remove });
    expect(result).toEqual({ kind: "blocked", reason: "notRevoked" });
    expect(remove).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("まだ解除されていません");
  });

  test("送り先が分からなければ、消すものが無いと言う（解除の終わりの問いでは黙る）", async () => {
    await fsp.writeFile(sitePath(), "{}\n");
    await fsp.rm(pointerPath());
    const result = await deleteEditingRepositoryFlow(work(), {}, allow);
    expect(result).toEqual({ kind: "blocked", reason: "noRemote" });
    expect(infos.join("\n")).toContain("場所が分かりません");

    infos.length = 0;
    const quiet = await deleteEditingRepositoryFlow(work(), { afterRevoke: true }, allow);
    expect(quiet).toEqual({ kind: "blocked", reason: "noRemote" });
    expect(infos).toEqual([]);
  });

  test("確認の窓には、元に戻せないこと・消すものの名前・許可を求められることを渡す。閉じれば残す", async () => {
    let seen: unknown;
    const remove = vi.fn();
    const result = await deleteEditingRepositoryFlow(
      work(),
      { afterRevoke: true },
      {
        hasDeleteScope: async () => false,
        token: async () => "token",
        remove,
        confirm: async (summary) => {
          seen = summary;
          return false;
        },
      }
    );
    expect(result).toEqual({ kind: "cancelled" });
    expect(remove).not.toHaveBeenCalled();
    expect(seen).toEqual({ fullName: "hisa/ice-editing", folder, afterRevoke: true, needsSignIn: true });
  });

  test("削除の許可の鍵が取れなければ消さず、GitHub の Settings で手で消す道を案内する", async () => {
    const remove = vi.fn();
    const result = await deleteEditingRepositoryFlow(work(), {}, { ...allow, token: async () => undefined, remove });
    expect(result).toEqual({ kind: "noToken" });
    expect(remove).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("Danger Zone");
    expect((await readSite(work())).remoteUrl).toBe("https://github.com/hisa/ice-editing.git");
  });

  test("GitHub が断ったら（403 など）、送り先の記録は外さない", async () => {
    const result = await deleteEditingRepositoryFlow(work(), {}, {
      ...allow,
      remove: async () => ({ ok: false, reason: "noPermission", detail: "このリポジトリを消す権限がありません" }),
    });
    expect(result.kind).toBe("failed");
    expect((await readSite(work())).remoteUrl).toBe("https://github.com/hisa/ice-editing.git");
    expect(await readPointer(work())).toEqual({ folderPath: folder });
    expect(warnings.join("\n")).toContain("Danger Zone");
  });
});
