import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  CANCEL_HINT,
  cancelItem,
  isCancelItem,
  withCancelHint,
} from "../../src/views/dialogs";

/**
 * 取りやめ方が分かること（設計書6.17.2、作者の指摘 2026-08-16）。
 *
 * **VS Codeの入力欄と選択画面には×ボタンが無い。** 閉じる方法は
 * `Esc` か外側のクリックだけで、この拡張機能は入力を失わせないために
 * `ignoreFocusOut: true` を多用している（外側をクリックしても閉じない）。
 * **つまり `Esc` が唯一の出口なのに、それを書いていなかった。**
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("入力欄", () => {
  test("説明の末尾に、取りやめ方を書く", () => {
    expect(withCancelHint("作品名を入力してください")).toBe(
      `作品名を入力してください${CANCEL_HINT}`
    );
  });

  test("二重に付けない", () => {
    const once = withCancelHint("説明");
    expect(withCancelHint(once)).toBe(once);
  });

  test("説明が無くても案内は出す", () => {
    // 見出しだけの入力欄でも、出口は要る
    expect(withCancelHint(undefined)).toContain("Escキー");
    expect(withCancelHint("")).toContain("Escキー");
  });

  test("`showInputBox` を直接呼ばない", () => {
    // **付け忘れが起きる。** 21か所あり、手で足すと必ずどれかを飛ばす
    const offenders = sourceFiles("src")
      .filter((file) => !file.endsWith(path.join("views", "dialogs.ts")))
      .filter((file) =>
        readFileSync(file, "utf-8").includes("window.showInputBox")
      )
      .map((file) => path.relative("src", file));

    expect(
      offenders,
      `askText（views/dialogs.ts）を使ってください: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});

describe("選択画面の「取りやめる」", () => {
  test("一覧の中に見える形で置ける", () => {
    // Escを知らない作者にも出口が見える
    const item = cancelItem();

    expect(item.label).toContain("取りやめる");
    expect(item.detail).toContain("何もせずに閉じます");
  });

  test("名前を変えられる", () => {
    // 多段の流れでは「すべて取りやめる」と書き分けたい
    expect(cancelItem("すべて取りやめる").label).toContain("すべて取りやめる");
  });

  test("押されたことを見分けられる", () => {
    expect(isCancelItem(cancelItem())).toBe(true);
  });

  test("普通の選択肢を取りやめと読み違えない", () => {
    expect(isCancelItem({ label: "短編" })).toBe(false);
    expect(isCancelItem(undefined)).toBe(false);
    expect(isCancelItem(null)).toBe(false);
    // ラベルが似ていても、印が無ければ取りやめではない
    expect(isCancelItem({ label: "$(close) 取りやめる" })).toBe(false);
  });
});
