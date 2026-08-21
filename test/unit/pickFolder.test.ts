import { describe, expect, it } from "vitest";
import { describeFolder } from "../../src/features/pickFolder";
import { Uri } from "./support/vscodeStub";

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
