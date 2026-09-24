import { describe, expect, test } from "vitest";
import * as nodePath from "node:path";
import { findWorkForFile } from "../../../src/core/workRegistry";

/**
 * 開いたファイルが属する作品を引き当てる（2026-09-24）。
 *
 * **ブラウザ版の実機で、本文を開いても下の欄（ステータスバー）に種類の目安も
 * 今日の執筆量も出なかった。** どちらも「作品が引き当てられたとき」だけ出す
 * ので、両方消えていたのは引き当てが外れていたから。
 *
 * - 登録簿の場所は、書庫の中を読んだ名前を `join` でつないだもの——生の日本語
 * - 開いた本文の場所は `paths.fromUri(document.uri)`——日本語が百分率符号化される
 *
 * 以前はこの判定が `extension.ts` の中にあってテストできなかったので、
 * 登録簿の引き方（`findWorkByFolder`）の隣へ出した。
 */

function work(id: string, folderPath: string) {
  return { id, title: id, folderPath };
}

describe("ブラウザ版の作品（URI）", () => {
  const works = [work("仮作品", "vscode-test-web://mount/仮作品")];

  test("符号化された本文の場所から、生の日本語で登録した作品を引ける", () => {
    const opened =
      "vscode-test-web://mount/%E4%BB%AE%E4%BD%9C%E5%93%81/episode_0001.txt";
    expect(findWorkForFile(works, opened)?.id).toBe("仮作品");
  });

  test("符号化されていない本文の場所でも引ける（これまでどおり）", () => {
    expect(
      findWorkForFile(works, "vscode-test-web://mount/仮作品/本文/1.txt")?.id
    ).toBe("仮作品");
  });

  test("作品の外のファイルは引かない", () => {
    expect(
      findWorkForFile(works, "vscode-test-web://mount/メモ.md")
    ).toBeUndefined();
    expect(
      findWorkForFile(works, "vscode-test-web://mount/%E4%BB%AE2/1.txt")
    ).toBeUndefined();
  });
});

describe("手元の作品（OS のパス）", () => {
  const root = nodePath.resolve("find-work-test");
  const outer = work("書庫", root);
  const inner = work("作品A", nodePath.join(root, "作品A"));

  test("中のファイルから作品を引ける", () => {
    expect(
      findWorkForFile([inner], nodePath.join(root, "作品A", "本文", "001.txt"))?.id
    ).toBe("作品A");
  });

  test("入れ子なら内側を選ぶ（並びの順に左右されない）", () => {
    const file = nodePath.join(root, "作品A", "本文", "001.txt");
    expect(findWorkForFile([outer, inner], file)?.id).toBe("作品A");
    expect(findWorkForFile([inner, outer], file)?.id).toBe("作品A");
  });

  test("作品フォルダーそのものは、中のファイルではない", () => {
    expect(findWorkForFile([inner], inner.folderPath)).toBeUndefined();
  });

  test.runIf(process.platform === "win32")(
    "Windows ではドライブ文字や綴りの大小が違っても引ける",
    () => {
      const works = [work("作品B", "C:\\Users\\作者\\小説\\作品B")];
      expect(
        findWorkForFile(works, "c:\\users\\作者\\小説\\作品b\\本文\\1.txt")?.id
      ).toBe("作品B");
    }
  );
});
