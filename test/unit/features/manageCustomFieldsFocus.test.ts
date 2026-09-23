import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * 設定資料項目追加の選択画面は、焦点が外れても閉じない
 * （ノートPCの実機確認、2026-09-23）。
 *
 * 名前と説明の入力欄（`askText`）は閉じない設定なのに、長さを選ぶ画面には
 * `ignoreFocusOut` が無かった。説明を空で Enter した直後に、横に開いていた
 * 設定資料のパネルやプロットモードへ焦点が戻り、長さの画面が一瞬で閉じて、
 * 知らせもログも無いまま項目が保存されなかった（作者の手で2回とも同じ）。
 *
 * 途中の段で閉じると、それまでの入力が黙って捨てられる。この流れの選択画面は
 * すべて閉じない設定にする（取りやめは各画面の「取りやめる」と Esc）。
 */
describe("設定資料項目追加の選択画面", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/features/manageCustomFields.ts"),
    "utf8"
  );
  const calls = source.split("vscode.window.showQuickPick(").slice(1);

  test("選択画面が4つある（種類・操作・長さ・外す項目）", () => {
    expect(calls).toHaveLength(4);
  });

  test.each([0, 1, 2, 3])("%i 番目の選択画面は焦点が外れても閉じない", (index) => {
    // 呼び出しのすぐ後の `if (`（答えを確かめる行）までに設定があること。
    // 隣の呼び出しの設定を拾わないよう、そこで切る
    const end = calls[index].indexOf("\n  if (");
    expect(end).toBeGreaterThan(0);
    expect(calls[index].slice(0, end)).toContain("ignoreFocusOut: true");
  });
});
