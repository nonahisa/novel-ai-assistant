import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { askText, cancelItem, isCancelItem } from "../../src/views/dialogs";
import { window } from "./support/vscodeStub";

/**
 * 取りやめ方が分かること（設計書6.17.2、作者の指摘 2026-08-16）。
 *
 * **VS Codeの入力欄と選択画面には×ボタンが無い。** 閉じる方法は
 * `Esc` か外側のクリックだけで、この拡張機能は入力を失わせないために
 * `ignoreFocusOut: true` を多用している（外側をクリックしても閉じない）。
 * **つまり `Esc` が唯一の出口なのに、それを書いていなかった。**
 *
 * **入力欄の案内は2026-09-21に製品側から外した。** VS Code 自身が
 * 「'Escape' を押して取り消します」を出しており、同じことを2回言う画面に
 * なっていた（実機で判明）。選択画面には VS Code の案内が出ないので、
 * `cancelItem` はそのまま残す。
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

/** askText が VS Code へ渡す内容のうち、ここで見るぶんだけ */
interface AskedOptions {
  readonly prompt?: string;
  readonly ignoreFocusOut?: boolean;
}

describe("入力欄", () => {
  test("取りやめ方を、製品からは書かない", async () => {
    // **VS Code 自身が「'Escape' を押して取り消します」を出す。**
    // 製品側でも書いていたので、同じことを2回言う画面になっていた
    // （2026-09-21、実機で判明）
    let passed: AskedOptions | undefined;
    const original = window.showInputBox;
    window.showInputBox = async (options?: unknown) => {
      passed = options as AskedOptions;
      return undefined;
    };
    try {
      await askText({ prompt: "リポジトリのURLを貼り付けてください" });
    } finally {
      window.showInputBox = original;
    }

    expect(passed?.prompt).toBe("リポジトリのURLを貼り付けてください");
    expect(passed?.prompt).not.toContain("Esc");
  });

  test("外側をクリックしても閉じない（出口は Esc だけ）", async () => {
    // `ignoreFocusOut` を外すと、別のウィンドウへ目を移した拍子に
    // 入力が消える（設計書6.4.1）
    let passed: AskedOptions | undefined;
    const original = window.showInputBox;
    window.showInputBox = async (options?: unknown) => {
      passed = options as AskedOptions;
      return undefined;
    };
    try {
      await askText({ prompt: "作品名" });
    } finally {
      window.showInputBox = original;
    }

    expect(passed?.ignoreFocusOut).toBe(true);
  });

  test("`showInputBox` を直接呼ばない", () => {
    // **`ignoreFocusOut` の付け忘れが起きる。** 数十か所あり、
    // 手で足すと必ずどれかを飛ばす（入力が消える画面が1つだけ残る）
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
