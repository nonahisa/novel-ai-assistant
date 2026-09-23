import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pickExistingWorkFolder } from "../../../src/features/pickFolder";
import { Uri, window, workspace } from "../support/vscodeStub";
import { isSameLocation } from "../../../src/core/locationCompare";

/**
 * 「フォルダから追加」の選択の窓が開く場所（2026-09-23、ノートPCの実機確認）。
 *
 * **実機で見つかった不具合の再現。** 窓が**選択中の作品の `設定` フォルダー
 * の中**から開いた。`defaultUri` を渡しておらず、VS Code が「最後に使った
 * 場所」を出していた。既にある作品フォルダーを選ぶ窓なので、作品が並んで
 * いる階層（書庫）から始める。
 */

const LIBRARY = "C:/Users/nonah/Documents/novels/novels";
const WORKS = [
  { folderPath: `${LIBRARY}/初恋相手の王女` },
  { folderPath: `${LIBRARY}/いじめられっ子` },
];

type WorkspaceWithFolders = { workspaceFolders?: unknown };

const originalShowOpenDialog = window.showOpenDialog;
const originalStat = workspace.fs.stat;

afterEach(() => {
  window.showOpenDialog = originalShowOpenDialog;
  workspace.fs.stat = originalStat;
  delete (workspace as WorkspaceWithFolders).workspaceFolders;
});

/** 窓を開いたときに渡された既定の場所を拾う */
function captureDialog(): { opened?: string } {
  const seen: { opened?: string } = {};
  window.showOpenDialog = async (options?: unknown) => {
    seen.opened = (options as { defaultUri?: { fsPath: string } }).defaultUri
      ?.fsPath;
    return undefined;
  };
  return seen;
}

describe("フォルダから追加の窓", () => {
  it("書庫から開く（作品の `設定` の中から始めない）", async () => {
    workspace.fs.stat = (async () => ({})) as never;
    (workspace as WorkspaceWithFolders).workspaceFolders = [
      { uri: Uri.file(`${LIBRARY}/初恋相手の王女/設定`), name: "設定" },
    ];
    const seen = captureDialog();

    await pickExistingWorkFolder({ works: WORKS });

    expect(seen.opened, "既定の場所を渡していない").toBeDefined();
    expect(isSameLocation(seen.opened ?? "", LIBRARY)).toBe(true);
  });

  it("作品がまだ無ければ、開いているフォルダーの先頭から開く", async () => {
    workspace.fs.stat = (async () => ({})) as never;
    (workspace as WorkspaceWithFolders).workspaceFolders = [
      { uri: Uri.file("C:/Users/nonah/Documents"), name: "Documents" },
      { uri: Uri.file("D:/ほか"), name: "ほか" },
    ];
    const seen = captureDialog();

    await pickExistingWorkFolder({ works: [] });

    expect(isSameLocation(seen.opened ?? "", "C:/Users/nonah/Documents")).toBe(
      true
    );
  });

  it("確かめられなくても窓は開く", async () => {
    workspace.fs.stat = (async () => {
      throw new Error("ドライブが見つかりません");
    }) as never;
    const seen = captureDialog();
    let called = false;
    const capture = window.showOpenDialog;
    window.showOpenDialog = async (options?: unknown) => {
      called = true;
      return capture(options as never);
    };

    await pickExistingWorkFolder({ works: WORKS });

    expect(called).toBe(true);
    expect(seen.opened).toBeUndefined();
  });

  it("「フォルダから追加」のコマンドがこの窓を使う", () => {
    const source = readFileSync("src/extension.ts", "utf8");
    const at = source.indexOf('registerCommand("novelai.addWork"');
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 1200);
    expect(body).toContain("pickExistingWorkFolder(");
  });
});
