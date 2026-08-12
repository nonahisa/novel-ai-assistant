import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";
import {
  appendAiActionLog,
  appliedFixKey,
  dismissKey,
  loadAppliedFixKeys,
  TypoDismissedHistory,
} from "../../src/core/typoIssueHistory";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "テスト作品",
  folderPath: "C:\\novels\\テスト作品",
  registeredAt: new Date(0).toISOString(),
};

describe("無視した指摘のキー", () => {
  test("同じ内容なら同じキーになる", () => {
    const issue = { line: 5, target: "意外", suggestion: "以外" };
    expect(dismissKey("chunk-a", issue)).toBe(dismissKey("chunk-a", issue));
  });

  test("チャンクが変われば別のキーになる", () => {
    const issue = { line: 5, target: "意外", suggestion: "以外" };
    expect(dismissKey("chunk-a", issue)).not.toBe(dismissKey("chunk-b", issue));
  });

  test("行・語・修正案のいずれが違っても別のキーになる", () => {
    const base = { line: 5, target: "意外", suggestion: "以外" };
    expect(dismissKey("c", base)).not.toBe(
      dismissKey("c", { ...base, line: 6 })
    );
    expect(dismissKey("c", base)).not.toBe(
      dismissKey("c", { ...base, target: "以外" })
    );
    expect(dismissKey("c", base)).not.toBe(
      dismissKey("c", { ...base, suggestion: "意外" })
    );
  });
});

describe("却下履歴とAI操作ログ", () => {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();

  beforeEach(() => {
    files.clear();
    directories.clear();
    workspace.fs = {
      createDirectory: vi.fn(async (uri: { fsPath: string }) => {
        directories.add(uri.fsPath);
      }),
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

  test("読めなければ空集合を返す", async () => {
    const history = new TypoDismissedHistory(work);
    expect(await history.load()).toEqual(new Set());
  });

  test("追加したキーを次回読み込みで取得できる", async () => {
    const history = new TypoDismissedHistory(work);
    await history.add(["key-1", "key-2"]);

    const reloaded = await new TypoDismissedHistory(work).load();
    expect(reloaded).toEqual(new Set(["key-1", "key-2"]));
  });

  test("重複したキーはまとめられる", async () => {
    const history = new TypoDismissedHistory(work);
    await history.add(["key-1"]);
    await history.add(["key-1", "key-2"]);

    const reloaded = await new TypoDismissedHistory(work).load();
    expect(reloaded).toEqual(new Set(["key-1", "key-2"]));
  });

  test("操作ログはJSONL形式で追記される", async () => {
    await appendAiActionLog(work, {
      category: "typo",
      action: "applied",
      file: "001.txt",
      line: 3,
      target: "意外",
      suggestion: "以外",
    });
    await appendAiActionLog(work, {
      category: "typo",
      action: "dismissed",
      file: "002.txt",
      line: 8,
      target: "行動",
      suggestion: "講堂",
    });

    const logPath = Uri.file(
      "C:\\novels\\テスト作品\\.aiwriter\\logs\\ai_actions.log"
    ).fsPath;
    const bytes = files.get(logPath);
    expect(bytes).toBeDefined();
    const lines = new TextDecoder()
      .decode(bytes)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      category: "typo",
      action: "applied",
      file: "001.txt",
      line: 3,
      target: "意外",
      suggestion: "以外",
    });
    expect(lines[1]).toMatchObject({ action: "dismissed", file: "002.txt" });
    expect(typeof lines[0].timestamp).toBe("string");
  });

  describe("適用済みの組の読み込み（往復ループ防止）", () => {
    test("ログが無ければ空集合を返す", async () => {
      expect(await loadAppliedFixKeys(work)).toEqual(new Set());
    });

    test("適用済みの組をキーとして読み込める", async () => {
      await appendAiActionLog(work, {
        category: "typo",
        action: "applied",
        file: "episode_0009.txt",
        line: 28,
        target: "良い",
        suggestion: "よい",
      });

      const keys = await loadAppliedFixKeys(work);
      expect(keys.has(appliedFixKey("episode_0009.txt", "良い", "よい"))).toBe(
        true
      );
    });

    test("却下（無視）は含めない。適用したものだけを対象にする", async () => {
      await appendAiActionLog(work, {
        category: "typo",
        action: "dismissed",
        file: "001.txt",
        line: 1,
        target: "良い",
        suggestion: "よい",
      });

      const keys = await loadAppliedFixKeys(work);
      expect(keys.has(appliedFixKey("001.txt", "良い", "よい"))).toBe(false);
    });

    test("壊れた行が混ざっていても、読める行は取り込む", async () => {
      await appendAiActionLog(work, {
        category: "typo",
        action: "applied",
        file: "001.txt",
        line: 1,
        target: "以外",
        suggestion: "意外",
      });
      const logPath = Uri.file(
        "C:\\novels\\テスト作品\\.aiwriter\\logs\\ai_actions.log"
      ).fsPath;
      const existing = files.get(logPath)!;
      const broken = new Uint8Array([
        ...existing,
        ...new TextEncoder().encode("これはJSONではない\n"),
      ]);
      files.set(logPath, broken);

      const keys = await loadAppliedFixKeys(work);
      expect(keys.has(appliedFixKey("001.txt", "以外", "意外"))).toBe(true);
    });
  });
});
