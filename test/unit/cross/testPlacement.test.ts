import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 単体テストの置き場所を見張る（作者の裁定、2026-09-23。残課題 A5）。
 *
 * ## なぜ機械で止めるか
 *
 * `test/unit/` に686ファイルが平らに並び、同じ題材が散っていたので、
 * **`src/` と同じ形のフォルダー**（`core`・`features`・`views` など）へ移した。
 * 決まりを文書に書くだけでは、次に足すテストがまた直下へ置かれる。
 *
 * ## 置き場所の決まり
 *
 * - 主に試す `src/` のファイルと同じフォルダー（`src/core/x.ts` → `test/unit/core/`）
 * - 1つのフォルダーに決まらないもの（複数のフォルダーにまたがる・ソースや文書を
 *   走査する網のテスト）は `test/unit/cross/`
 * - `test/unit/support/` はテストの部品（テストファイルは置かない）
 */
const UNIT = path.resolve(__dirname, "..");
const SRC = path.resolve(__dirname, "../../../src");

describe("単体テストの置き場所", () => {
  test("test/unit/ の直下にテストファイルを置かない", () => {
    const flat = fs
      .readdirSync(UNIT, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => entry.name);
    expect(
      flat,
      "src と同じ形のフォルダー（core・features など）か cross/ へ置いてください"
    ).toEqual([]);
  });

  test("フォルダーは src のフォルダーと cross・support だけ", () => {
    const srcFolders = fs
      .readdirSync(SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const allowed = new Set([...srcFolders, "cross", "support"]);
    const unknown = fs
      .readdirSync(UNIT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !allowed.has(entry.name))
      .map((entry) => entry.name);
    expect(unknown).toEqual([]);
  });

  test("support/ にはテストファイルを置かない", () => {
    const inSupport = fs
      .readdirSync(path.join(UNIT, "support"))
      .filter((name) => name.endsWith(".test.ts"));
    expect(inSupport).toEqual([]);
  });
});
