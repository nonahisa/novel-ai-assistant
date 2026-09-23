import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, workspace } from "./support/vscodeStub";
import { AnnouncementHistory } from "../../src/core/announcementHistory";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "テスト作品",
  folderPath: "C:\\novels\\テスト作品",
  registeredAt: new Date(0).toISOString(),
};

describe("更新告知の履歴", () => {
  const files = new Map<string, Uint8Array>();

  beforeEach(() => {
    files.clear();
    workspace.fs = {
      createDirectory: vi.fn(async () => undefined),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const bytes = files.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      }),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(uri.fsPath, bytes);
      }),
      rename: vi.fn(
        async (
          from: { fsPath: string },
          to: { fsPath: string },
          options?: { overwrite?: boolean }
        ) => {
          const bytes = files.get(from.fsPath);
          if (!bytes) throw new Error("一時ファイルがありません");
          if (!options?.overwrite && files.has(to.fsPath)) {
            throw new FileSystemError("exists", "FileExists");
          }
          files.set(to.fsPath, bytes);
          files.delete(from.fsPath);
        }
      ),
      readDirectory: vi.fn(async () => []),
      delete: vi.fn(async (uri: { fsPath: string }) => {
        files.delete(uri.fsPath);
      }),
    };
  });

  test("まだ何も無ければ空を返す", () => {
    // 履歴は無くても機能が成り立つ。読めないことを失敗にしない
    return expect(new AnnouncementHistory(work).load()).resolves.toEqual([]);
  });

  test("足したものを次に読める", async () => {
    await new AnnouncementHistory(work).add(["最初の告知"]);

    expect(await new AnnouncementHistory(work).load()).toEqual(["最初の告知"]);
  });

  test("同じ言い回しは1つにまとめる", async () => {
    const history = new AnnouncementHistory(work);
    await history.add(["同じ告知"]);
    await history.add(["同じ告知", "別の告知"]);

    expect(await history.load()).toEqual(["同じ告知", "別の告知"]);
  });

  test("空文字は覚えない", async () => {
    await new AnnouncementHistory(work).add(["", "  ", "中身のある告知"]);

    expect(await new AnnouncementHistory(work).load()).toEqual([
      "中身のある告知",
    ]);
  });

  test("20件で切り、新しいほうを残す", async () => {
    // 増やしすぎるとプロンプトが膨らむ。避ける相手は直近のもので足りる
    const history = new AnnouncementHistory(work);
    for (let i = 1; i <= 25; i++) await history.add([`告知${i}`]);

    const loaded = await history.load();
    expect(loaded).toHaveLength(20);
    expect(loaded[0]).toBe("告知6");
    expect(loaded[19]).toBe("告知25");
  });

  test("壊れた中身は空として読む（機能を止めない）", async () => {
    const history = new AnnouncementHistory(work);
    await history.add(["いったん保存する"]);
    // 保存先を手で壊した体にする
    for (const key of [...files.keys()]) {
      files.set(key, new TextEncoder().encode("{壊れたJSON"));
    }

    expect(await history.load()).toEqual([]);
  });
});
