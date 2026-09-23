import { describe, expect, test } from "vitest";
import { isStaleBundleError } from "../../src/core/staleBundle";

/**
 * 拡張機能が裏で入れ替わったあとにコマンドを押すと落ちる件（設計書6.106）。
 *
 * **見分けを間違えると被害が逆向きになる。** 取り違えて「更新されています」と
 * 出せば、作者の原稿が消えている本物の失敗を再読み込みで握り潰すことになる。
 * 真にする形と偽にする形を、両方とも並べて見張る。
 */
const EXTENSION_PATH =
  "C:\\Users\\nonah\\.vscode\\extensions\\nonahisa.novel-ai-assistant-0.69.10";

describe("拡張機能の入れ替わりを見分ける", () => {
  describe("真にする", () => {
    test("ERR_MODULE_NOT_FOUND は、それだけで真", () => {
      // 動的 import が束そのものを見つけられなかった印。
      // パスを見るまでもない
      const error = Object.assign(new Error("Cannot find module"), {
        code: "ERR_MODULE_NOT_FOUND",
      });

      expect(isStaleBundleError(error, EXTENSION_PATH)).toBe(true);
    });

    test("ENOENT で、消えた先が拡張機能の置き場の中", () => {
      const error = new Error(
        `ENOENT: no such file or directory, open '${EXTENSION_PATH}\\dist\\extension.js'`
      );

      expect(isStaleBundleError(error, EXTENSION_PATH)).toBe(true);
    });

    test("区切りが `/` でも同じ場所と見る", () => {
      const error = new Error(
        "ENOENT: no such file or directory 'C:/Users/nonah/.vscode/extensions/nonahisa.novel-ai-assistant-0.69.10/dist/extension.js'"
      );

      expect(isStaleBundleError(error, EXTENSION_PATH)).toBe(true);
    });

    test("作者の本番で実際に出た文言（ドライブ文字が小文字）", () => {
      // exthost.log に残っていた実例そのもの。`c:\Users\...` と
      // 小文字で来たため、そのまま比べると一致しない
      const error = new Error(
        "ENOENT: no such file or directory 'c:\\Users\\nonah\\.vscode\\extensions\\nonahisa.novel-ai-assistant-0.69.10\\dist\\extension.js'"
      );

      expect(isStaleBundleError(error, EXTENSION_PATH)).toBe(true);
    });
  });

  describe("偽にする", () => {
    test("ENOENT でも、作品ファイルなら偽", () => {
      // 作者の原稿が消えた・移された等。再読み込みしても直らないので、
      // 更新の案内を出してはいけない
      const error = new Error(
        "ENOENT: no such file or directory, open 'C:\\Users\\nonah\\Documents\\小説\\第01話.txt'"
      );

      expect(isStaleBundleError(error, EXTENSION_PATH)).toBe(false);
    });

    test("普通の Error は偽", () => {
      expect(
        isStaleBundleError(new Error("AIの応答を解釈できませんでした"), EXTENSION_PATH)
      ).toBe(false);
    });

    test("文字列は偽", () => {
      expect(isStaleBundleError("ENOENT", EXTENSION_PATH)).toBe(false);
    });

    test("undefined は偽", () => {
      expect(isStaleBundleError(undefined, EXTENSION_PATH)).toBe(false);
    });

    test("置き場が空なら判断しない", () => {
      // 空文字はどんな文字列にも含まれる。ここを素通しにすると
      // ENOENT がすべて「更新されています」になる
      const error = new Error("ENOENT: no such file or directory 'x'");

      expect(isStaleBundleError(error, "")).toBe(false);
    });
  });
});
