import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";
import {
  appendAiActionLog,
  appliedFixKey,
  dismissKey,
  isDismissed,
  legacyDismissKey,
  loadAppliedFixKeys,
  TypoDismissedHistory,
} from "../../../src/core/typoIssueHistory";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "テスト作品",
  folderPath: "C:\\novels\\テスト作品",
  registeredAt: new Date(0).toISOString(),
};

describe("無視した指摘のキー", () => {
  const issue = { line: 5, target: "意外", suggestion: "以外" };

  test("同じ内容なら同じキーになる", () => {
    expect(dismissKey("本文/001.txt", issue)).toBe(
      dismissKey("本文/001.txt", issue)
    );
  });

  test("ファイルが違えば別のキーになる", () => {
    expect(dismissKey("本文/001.txt", issue)).not.toBe(
      dismissKey("本文/002.txt", issue)
    );
  });

  test("絶対パスでも相対パスでも同じキーになる", () => {
    // 呼ぶ場所によってどちらも来る。ファイル名だけで揃える
    expect(dismissKey("C:\\novels\\作品\\本文\\001.txt", issue)).toBe(
      dismissKey("本文/001.txt", issue)
    );
  });

  test("チャンクの分け方が変わってもキーは変わらない", () => {
    // **以前はチャンクのハッシュを鍵にしていた。** まとめ方を変えたり
    // 本文をどこか1文字直したりするだけで鍵が変わり、無視したはずの
    // 指摘がまた出てきていた（設計書6.8.10）
    expect(dismissKey("本文/001.txt", issue)).toBe(
      dismissKey("本文/001.txt", { ...issue })
    );
  });

  test("語・修正案のいずれが違えば別のキーになる", () => {
    expect(dismissKey("a.txt", issue)).not.toBe(
      dismissKey("a.txt", { ...issue, target: "以外" })
    );
    expect(dismissKey("a.txt", issue)).not.toBe(
      dismissKey("a.txt", { ...issue, suggestion: "意外" })
    );
  });

  /**
   * **鍵から行番号を外した**（設計書6.96.3）。以前は
   * `ファイル名｜行｜原文｜修正案` だったので、本文を1行足しただけで
   * 鍵が変わり、**見送ったはずの指摘がまた出てきた**。
   */
  test("行が動いてもキーは変わらない（古い不具合の再現）", () => {
    // 鍵を作る側は語と修正案しか受け取らない形になったので、行を書いた
    // まま直に渡すと型で弾かれる。**指摘そのものは行を持ち続ける**ので、
    // 行を持った指摘を組んでから渡して、鍵が行を見ないことを見る
    const movedALittle = { ...issue, line: 6 };
    const movedFar = { ...issue, line: 999 };

    expect(dismissKey("a.txt", issue)).toBe(dismissKey("a.txt", movedALittle));
    expect(dismissKey("a.txt", issue)).toBe(dismissKey("a.txt", movedFar));
  });
});

/**
 * 既にある `typo_dismissed.json` には**古い形の鍵**が入っている。
 * 作者のファイルを書き換えて移行しない（実装ルール2）ので、
 * **読むときに両方の形で照らす**——`externalAccessPermission.ts` の
 * `LEGACY_TOOL_KEYS` と同じ作法である。
 */
describe("古い形の鍵も読める", () => {
  const issue = { line: 5, target: "意外", suggestion: "以外" };

  test("新しい形で覚えてあれば、行が動いても効く", () => {
    const dismissed = new Set([dismissKey("a.txt", issue)]);

    expect(isDismissed(dismissed, "a.txt", issue)).toBe(true);
    expect(isDismissed(dismissed, "a.txt", { ...issue, line: 40 })).toBe(true);
  });

  test("古い形で覚えてあっても、同じ行なら効く", () => {
    // 作者の `typo_dismissed.json` に既に入っている形
    const dismissed = new Set([legacyDismissKey("a.txt", issue)]);

    expect(isDismissed(dismissed, "a.txt", issue)).toBe(true);
  });

  /**
   * 古い鍵は行を含むので、動いたあとは当たらない。**それは元の不具合
   * そのもの**で、ここで直せるものではない。一度だけまた出てくるが、
   * そこで見送れば新しい形で覚え直される。
   */
  test("古い形は、行が動くと当たらない（覚え直しで回復する）", () => {
    const dismissed = new Set([legacyDismissKey("a.txt", issue)]);
    const moved = { ...issue, line: 40 };

    expect(isDismissed(dismissed, "a.txt", moved)).toBe(false);

    dismissed.add(dismissKey("a.txt", moved));
    expect(isDismissed(dismissed, "a.txt", { ...issue, line: 77 })).toBe(true);
  });

  test("覚えていない指摘は、当然当たらない", () => {
    const dismissed = new Set([dismissKey("a.txt", issue)]);

    expect(isDismissed(dismissed, "b.txt", issue)).toBe(false);
    expect(
      isDismissed(dismissed, "a.txt", { ...issue, suggestion: "意外" })
    ).toBe(false);
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

    test("戻したものは、適用済みから外れる", async () => {
      // **戻したのに次の検知で二度と挙がってこない**、を防ぐ（設計書6.8.12）
      await appendAiActionLog(work, {
        category: "typo",
        action: "applied",
        file: "001.txt",
        line: 5,
        target: "意外",
        suggestion: "以外",
      });
      expect(await loadAppliedFixKeys(work)).toContain(
        appliedFixKey("001.txt", "意外", "以外")
      );

      await appendAiActionLog(work, {
        category: "typo",
        action: "reverted",
        file: "001.txt",
        line: 5,
        target: "意外",
        suggestion: "以外",
      });
      expect(await loadAppliedFixKeys(work)).not.toContain(
        appliedFixKey("001.txt", "意外", "以外")
      );
    });

    test("戻したあとにもう一度適用すれば、また適用済みになる", async () => {
      // 記録は追記だけなので、後の行が勝つ
      for (const action of ["applied", "reverted", "applied"] as const) {
        await appendAiActionLog(work, {
          category: "typo",
          action,
          file: "002.txt",
          line: 1,
          target: "良い",
          suggestion: "よい",
        });
      }
      expect(await loadAppliedFixKeys(work)).toContain(
        appliedFixKey("002.txt", "良い", "よい")
      );
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
