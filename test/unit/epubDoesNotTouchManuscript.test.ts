import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * **EPUB の飾りは、本文へ触れない**（設計書6.65）。実機確認 A-19 の棚卸し項目。
 *
 * A-19 は「履歴にも退避にも残らない本文の書き換えが起きた」（2026-09-06、
 * 原因未特定）から始まった棚卸しである。**本文を書く経路を数え上げて、
 * 記録の残らないものが無いかを確かめる**のがその中身で、
 * 0.37.x で入った新しい機能——口述筆記モードと EPUB の飾り——が
 * 本文へ触れていないかが残っていた。
 *
 * ## 2つは事情が違う
 *
 * - **口述筆記モードは、意図して本文を書く。** 整えた文を入れるのが機能で、
 *   0.40.8 から編集履歴にも残る（`dictationHistory.test.ts`）。
 *   これは「触れていない」ではなく「触れるが、記録が残る」で片が付いている
 * - **EPUB の飾り（挿絵・口絵・改ページ・登場人物の面）は、触れてはいけない。**
 *   置き場は `設定/book.json` で、本文は**読むだけ**である。
 *   ここが崩れると、本を組んだだけで原稿が変わることになる
 *
 * ## ここで守ること
 *
 * 画面（`epubEditorPanel.ts`）も書き出し（`exportEpub.ts`）も、
 * **本文を書く口をそもそも持たない**。持っていなければ、うっかり書くことも無い。
 */

function sourceOf(relative: string): string {
  return readFileSync(resolve(__dirname, "../..", relative), "utf8");
}

const PANEL = sourceOf("src/features/epubEditorPanel.ts");
const EXPORT = sourceOf("src/features/exportEpub.ts");
const STORE = sourceOf("src/core/bookStore.ts");

describe("EPUB は本文へ触れない", () => {
  test("**画面は、本文を読むだけ**", () => {
    // 読む口は持つ（本文から本を組むので要る）
    expect(PANEL).toContain('readTextFile');
    // 書く口は持たない
    expect(PANEL).not.toContain("writeTextFilePreservingFormat");
  });

  test("**書き出しも、本文を読むだけ**", () => {
    expect(EXPORT).toContain("readTextFile");
    expect(EXPORT).not.toContain("writeTextFilePreservingFormat");
  });

  test("**書き出す `.epub` は新規作成だけ**（既存を上書きしない）", () => {
    // 同じ名前の本があったら上書きせずに失敗する。上書きを許すと、
    // 前に焼いた本が黙って置き換わる（設計書5.4.1 の「既存ファイルを壊さない」）
    expect(EXPORT).toContain('atomicWriteFile(target, epub, { mode: "create" })');
  });

  test("台帳が消すのは、自分の下書きだけ", () => {
    // `bookStore` の delete は1か所で、行き先は draftPath（未保存の控え）。
    // ここが本文の道を指したら、本を編集しただけで話が消える
    const deletes = STORE.split("workspace.fs.delete(").length - 1;
    expect(deletes).toBe(1);
    const at = STORE.indexOf("workspace.fs.delete(");
    expect(STORE.slice(at, at + 120)).toContain("draftPath()");
  });

  test("口述筆記は、触れるかわりに履歴へ残す（こちらは別の決まり）", () => {
    // 「本文へ触れていないか」を EPUB と口述で同じ問いにしない。
    // 口述は触れるのが機能で、残すことで筋を通している（0.40.8）
    const dictation = sourceOf("src/features/dictationClean.ts");
    expect(dictation).toContain("recordEdit(work, {");
    expect(dictation).toContain("口述筆記の整文を反映した");
  });
});
