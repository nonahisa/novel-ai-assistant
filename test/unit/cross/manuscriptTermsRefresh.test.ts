import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 設定資料パネルで人物を保存したら、開いたままの原稿エディターへ用語を送り直す
 * （設計書6.5.8。2026-10-11）。
 *
 * ## 何が起きていたか
 *
 * 原稿を横に出したまま、設定資料で別名「お嬢様」を「別の人物に分ける」。
 * そのまま原稿の「お嬢様」を右クリックして「設定資料を見る」を押すと、
 * **古い持ち主（密倉文佳）の資料が出た。** 吹き出しの名前も古いままだった。
 *
 * 保存のあと `extension.ts` の見張り（`setSettingsChangeObserver`）は
 * 色分けの控えを捨てる（`highlighter.invalidate()`）。ただし、これが引き直すのは
 * 素のテキストエディターの色だけである。原稿エディターは画面へ用語の位置と
 * 持ち主（`terms`・`marks`）を送ったきりで、送り直すのは本文の変更・配色や
 * 設定の変更・タブが前へ出たとき・開いた直後だけだった。
 *
 * ## 見張り方
 *
 * `resolveCustomTextEditor` を代役で組むには依存が多すぎるので、源の形で見張る
 * （`manuscriptFootRefresh.test.ts` と同じ手）。画面まで通した確かめは E2E の
 * `settingsSeparateHighlight.test.ts` が持つ。
 */

const read = (file: string): string => readFileSync(file, "utf8");

/** 見出しから n 文字（その関数の中を見るため） */
function body(source: string, head: string, length: number): string {
  const at = source.indexOf(head);
  expect(at, `見つからない: ${head}`).toBeGreaterThanOrEqual(0);
  return source.slice(at, at + length);
}

describe("設定資料の保存で、開いている原稿エディターへ用語を送り直す", () => {
  test("見張りは、控えを捨てたあとで原稿エディターへ送り直す（古い控えを読まない順）", () => {
    const observer = body(
      read("src/extension.ts"),
      "setSettingsChangeObserver((work) => {",
      1200
    );
    const invalidated = observer.indexOf("highlighter.invalidate()");
    const resent = observer.indexOf("refreshAllManuscriptTerms()");
    expect(invalidated).toBeGreaterThanOrEqual(0);
    expect(resent).toBeGreaterThan(invalidated);
  });

  test("開いている原稿エディターすべてへ送り直す口がある", () => {
    const refresh = body(
      read("src/features/manuscriptEditor.ts"),
      "export function refreshAllManuscriptTerms(",
      600
    );
    expect(refresh).toContain("openManuscripts");
    expect(refresh).toContain(".resendTerms()");
  });

  test("台帳の1枚ぶんは、待たずに本文と用語を送り直す（send を通す）", () => {
    const editor = read("src/features/manuscriptEditor.ts");
    const resolve = body(editor, "async resolveCustomTextEditor(", 40000);
    const entry = body(resolve, "resendTerms:", 600);
    expect(entry).toMatch(/sendNow\(\)|send\(\)/);
  });
});
