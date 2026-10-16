import * as nodePath from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";
import { installFakeDisk, openFakeDocument, type FakeDisk } from "../support/openDocumentFake";
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

/**
 * 相談パネルの書き込み（決まったこと・まとめ・［書き込む］）も、plot.md が開いていれば
 * **文書へ当てて保存する**（`core/openDocumentEdit.ts`。作者の裁定「両方直す」、2026-10-16）。
 * ディスクを消して作り直すと、開いたままのエディターで Ctrl+S が「ファイルのほうが新しい」で断られる。
 */
describe("applyChatEdit：plot.md がエディターで開いているとき", () => {
  let disk: FakeDisk;
  const initial = "# 氷の街\n\n## タイトル\n既存のタイトル\n";

  beforeEach(() => {
    disk = installFakeDisk();
    disk.write(plotPath, initial);
    workspace.textDocuments.length = 0;
  });

  afterEach(() => {
    workspace.textDocuments.length = 0;
    workspace.applyEdit = async () => true;
  });

  test("ディスクを消して作り直さず、文書へ当てて保存する", async () => {
    const document = openFakeDocument(disk, plotPath, initial);

    await applyChatEdit(work, {
      target: { kind: "plot", section: "title" },
      content: "新しいタイトル",
      label: "タイトルを変える",
    });

    expect(disk.deleted).toEqual([]);
    // 当てるのは変わった所だけ（「既存の」→「新しい」）
    expect(document.applied).toEqual(["新しい"]);
    expect(document.text).toBe("# 氷の街\n\n## タイトル\n新しいタイトル\n");
    expect(document.save).toHaveBeenCalledTimes(1);
    expect(disk.read(plotPath)).toContain("新しいタイトル");
  });

  test("未保存の変更があれば書かずに止める", async () => {
    const document = openFakeDocument(disk, plotPath, initial + "書きかけ", { dirty: true });

    await expect(
      applyChatEdit(work, {
        target: { kind: "plot", section: "title" },
        content: "新しいタイトル",
        label: "タイトルを変える",
      })
    ).rejects.toThrow(/保存していない/);
    expect(document.applied).toEqual([]);
    expect(disk.read(plotPath)).toBe(initial);
  });
});
