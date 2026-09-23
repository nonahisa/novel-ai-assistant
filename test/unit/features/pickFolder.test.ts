import { afterEach, describe, expect, it } from "vitest";
import {
  defaultParentForNewFolder,
  describeFolder,
  pickNewFolderParent,
} from "../../src/features/pickFolder";
import { FileSystemError, Uri, window, workspace } from "./support/vscodeStub";
import { isSameLocation } from "../../src/core/locationCompare";

/**
 * 開いているフォルダーの見せ方（設計書5.8.8）。
 *
 * **ブラウザ版では、フォルダーを選ぶダイアログを当てにできない。**
 * 代わりに開いているフォルダー（ワークスペース）から選ばせるので、
 * **どこのリポジトリかが選択肢から読めないと選べない。**
 * 同じ名前のフォルダーを別の場所で開いていることがある。
 */

describe("開いているフォルダーの説明", () => {
  it("手元のファイルは、OSのパスをそのまま出す", () => {
    const uri = Uri.file("C:\\Users\\nonah\\Documents\\いじめられっ子");
    expect(describeFolder(uri as never)).toBe(uri.fsPath);
  });

  it("GitHubのリポジトリは、持ち主と名前が分かる形にする", () => {
    const uri = Uri.parse("vscode-vfs://github/nonahisa/HisasNovels");
    expect(describeFolder(uri as never)).toBe("github: nonahisa/HisasNovels");
  });

  it("先頭のスラッシュを重ねない", () => {
    const uri = Uri.parse("vscode-vfs://github/owner/repo");
    expect(describeFolder(uri as never)).not.toContain(": /");
  });
});

/**
 * 「新しい置き場を作る」ときに窓が開く場所（設計書6.97.6）。
 *
 * **実機で見つかった不具合の再現。** 2026-09-21、「GitHubから作品を追加」の
 * フォルダー選択が `…/novels/novels/初恋相手の王女…`——**作者の原稿
 * フォルダーの中**を開いた状態で立ち上がった。`defaultUri` を渡していないと、
 * VS Codeは「最後に使った場所」を出す。そのまま押せば原稿の中に書庫が入る。
 *
 * **場所は区切りを揃えて比べる**（`isSameLocation`）。窓へ渡るのは
 * `Uri` なので、書いたとおりの綴りでは戻ってこない。
 */
const LIBRARY = "C:/Users/nonah/Documents/novels/novels";
const ABOVE_LIBRARY = "C:/Users/nonah/Documents/novels";
const WORKS = [
  { folderPath: `${LIBRARY}/初恋相手の王女` },
  { folderPath: `${LIBRARY}/いじめられっ子` },
];

const originalShowOpenDialog = window.showOpenDialog;
const originalStat = workspace.fs.stat;

afterEach(() => {
  window.showOpenDialog = originalShowOpenDialog;
  workspace.fs.stat = originalStat;
});

/** どのフォルダーも実在する体にする（既定の候補が実在確認を通る） */
function everythingExists(): void {
  workspace.fs.stat = (async () => ({})) as never;
}

describe("新しい置き場を選ぶ窓", () => {
  it("作品フォルダーの中を開かない", async () => {
    everythingExists();
    let opened: string | undefined;
    window.showOpenDialog = async (options?: unknown) => {
      opened = (options as { defaultUri?: { fsPath: string } }).defaultUri
        ?.fsPath;
      return undefined;
    };

    await pickNewFolderParent({
      purpose: "作品フォルダを置く場所を選択",
      openLabel: "ここに取り寄せる",
      works: WORKS,
    });

    expect(opened, "既定の場所を渡していない").toBeDefined();
    for (const work of WORKS) {
      expect(
        isSameLocation(opened ?? "", work.folderPath),
        `作品フォルダーの中が開く: ${opened}`
      ).toBe(false);
    }
    // 書庫の1つ上。書庫の中はリポジトリの入れ子になるので選ばない
    expect(isSameLocation(opened ?? "", LIBRARY)).toBe(false);
    expect(isSameLocation(opened ?? "", ABOVE_LIBRARY)).toBe(true);
  });

  it("候補の場所がもう無ければ、既定を渡さない", async () => {
    // 作品を移したあとなど。実在しない場所を開かせても仕方がない
    workspace.fs.stat = (async () => {
      throw new FileSystemError("not found", "FileNotFound");
    }) as never;

    expect(await defaultParentForNewFolder(WORKS)).toBeUndefined();
  });

  it("確かめられなくても窓は開く", async () => {
    // 外したドライブなどで stat が転ぶ。**既定は親切であって、
    // フォルダーを選べなくなってよい理由にはならない**
    workspace.fs.stat = (async () => {
      throw new Error("ドライブが見つかりません");
    }) as never;
    let called = false;
    window.showOpenDialog = async () => {
      called = true;
      return undefined;
    };

    await pickNewFolderParent({
      purpose: "作品フォルダを置く場所を選択",
      openLabel: "ここに取り寄せる",
      works: WORKS,
    });

    expect(called).toBe(true);
  });
});
