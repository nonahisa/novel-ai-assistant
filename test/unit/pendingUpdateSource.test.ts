import * as nodePath from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, FileType, Uri, workspace } from "./support/vscodeStub";
import { PendingUpdateStore } from "../../src/core/pendingUpdates";
import { emptyCharacter } from "../../src/models/character";
import type { WorkEntry } from "../../src/models/types";

/**
 * 承認待ちの更新案の「出どころ」（設計書6.4.9）。
 *
 * プロットから積んだ提案は、AIの抽出から来たものと**見分けが付かないと
 * いけない**。読み方が違う（片方は作者が書いた文、片方はAIの読み）ので、
 * 承認するときの判断が変わる。
 *
 * **古い承認待ちも読めること。** 出どころを足す前に積まれたファイルは
 * 人物のJSONそのものなので、そのまま読めなければ、作者の環境に残っている
 * 提案が黙って消える。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const pendingDir = nodePath.join(work.folderPath, ".aiwriter", "pending-characters");

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

describe("承認待ちの更新案の出どころ", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      readDirectory: async () =>
        [...disk.keys()]
          .filter((key) => key.startsWith(diskPath(pendingDir)))
          .map((key) => [nodePath.basename(key), FileType.File]),
    } as unknown as typeof workspace.fs;
  });

  test("出どころを添えて積み、読み戻せる", async () => {
    const store = new PendingUpdateStore(work);
    await store.stage([{ ...emptyCharacter("char_001", "灯"), summary: "主人公" }], {
      source: "plot",
    });

    const { updates, errors } = await store.loadAll();
    expect(errors).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0].character.name).toBe("灯");
    expect(updates[0].source).toBe("plot");
  });

  test("出どころを言わずに積んだものは、これまでどおり読める", async () => {
    const store = new PendingUpdateStore(work);
    await store.stage([emptyCharacter("char_002", "澪")]);

    const { updates } = await store.loadAll();
    expect(updates).toHaveLength(1);
    expect(updates[0].character.name).toBe("澪");
    expect(updates[0].source).toBeUndefined();
  });

  test("出どころを足す前に積まれたファイル（人物のJSONそのもの）も読める", async () => {
    const character = emptyCharacter("char_003", "太志");
    disk.set(
      diskPath(nodePath.join(pendingDir, "char_003.json")),
      new TextEncoder().encode(`${JSON.stringify(character, null, 2)}\n`)
    );

    const { updates, errors } = await new PendingUpdateStore(work).loadAll();
    expect(errors).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0].character.name).toBe("太志");
    expect(updates[0].source).toBeUndefined();
  });

  test("話数の付け替えなどで積み直しても、出どころは消えない", async () => {
    const store = new PendingUpdateStore(work);
    const character = emptyCharacter("char_001", "灯");
    await store.stage([character], { source: "plot" });
    // 出どころを言わない積み直し（episodeLedgers の追従がこの形）
    await store.stage([{ ...character, appearedChapters: [2] }]);

    const { updates } = await store.loadAll();
    expect(updates[0].character.appearedChapters).toEqual([2]);
    expect(updates[0].source).toBe("plot");
  });
});
