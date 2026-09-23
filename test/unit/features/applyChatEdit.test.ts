import * as nodePath from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";
import { applyChatEdit } from "../../../src/features/applyChatEdit";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 相談パネルからの書き込みは `applyChatEdit` を通る（設計書6.4.7）。
 *
 * **`workChatPanelAutoEdit.test.ts` は `applyChatEdit` を丸ごとモックし、
 * 「空の提案は書かない」という `updatePlotMarkdown` の本物の挙動を
 * モックの中に手で書き写しているだけだった。** モックが本物と食い違えば、
 * そちらのテストは気づけないまま通り続ける。
 *
 * ここでは `applyChatEdit` そのものを呼び、書き込み先は `vscodeStub` の
 * 偽ディスク（メモリ上の Map）にする。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work_chat_edit"),
  registeredAt: "2026-09-22T00:00:00.000Z",
};

const plotPath = nodePath.join(work.folderPath, "設定", "plot.md");

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

describe("applyChatEdit：空の提案を書き込みで捨てる", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.fs = {
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
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
    } as unknown as typeof workspace.fs;

    // 既存の plot.md に、既にタイトルが書かれている状態を用意する
    const initial = "# 氷の街\n\n## タイトル\n既存のタイトル\n";
    disk.set(diskPath(plotPath), new TextEncoder().encode(initial));
  });

  function readPlot(): string {
    const bytes = disk.get(diskPath(plotPath));
    return bytes ? new TextDecoder().decode(bytes) : "";
  }

  test("空の提案では、既存の中身をそのまま残す", async () => {
    await applyChatEdit(work, {
      target: { kind: "plot", section: "title" },
      content: "",
      label: "タイトルを消す",
    });

    // `updatePlotMarkdown` が空の更新を捨てるので、書き戻されても中身は同じ
    expect(readPlot()).toContain("既存のタイトル");
  });

  test("空でない提案は、そのまま書き込む", async () => {
    await applyChatEdit(work, {
      target: { kind: "plot", section: "title" },
      content: "新しいタイトル",
      label: "タイトルを変える",
    });

    const written = readPlot();
    expect(written).toContain("新しいタイトル");
    expect(written).not.toContain("既存のタイトル");
  });
});
