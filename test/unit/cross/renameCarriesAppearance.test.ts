import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `.txt` を `.md` にしたあとも、見た目を引き継ぐ（設計書6.25.5）。
 *
 * ## 何が起きていたか
 *
 * 作者の依頼（2026-09-12）「前の話や次の話でファイル間を動いた場合、
 * 縦書き横書き、書体、倍率は元の設定に合わせて変更してください」に対して、
 * 0.47.9 は**前後の話と最新話だけ**に引き継ぎを付けた。
 * `.txt`→`.md` の変換は「同じ原稿の開き直しだから既定でよい」と見て
 * 外していた（0.47.4 の積み残し⑦）。
 *
 * **これは見立てが違う。** 変換は**ファイルの名前を変える**。見た目は
 * 原稿ごとに覚える値なので、名前が変われば宛先も変わり、開き直したときに
 * 設定の既定へ戻る。中身は同じ原稿なのに縦書きが横書きになるので、
 * 作者から見れば壊れている。
 *
 * ## このテストの性質
 *
 * 直したのは画面と変換のあいだの配線で、純粋な関数ではない
 * （見た目を決める規則そのものは `manuscriptAppearance.test.ts` が見る）。
 * ここでは**配線が戻っていないこと**をソースの形で押さえる
 * （`manuscriptCarryAppearance.test.ts` と同じ考え方）。
 */

const editor = readFileSync(
  resolve(__dirname, "../../src/features/manuscriptEditor.ts"),
  "utf8"
);
const convert = readFileSync(
  resolve(__dirname, "../../src/features/markdownConvert.ts"),
  "utf8"
);

describe("名前が変わっても、見た目を引き継ぐ", () => {
  test("持ち越す口がある", () => {
    expect(editor).toContain(
      "export function carryAppearanceToRenamed(from: string, to: string): void {"
    );
    // 元の画面から今の見た目を取り、新しい名前の宛先へ置く
    expect(editor).toContain("openManuscripts.get(manuscriptLedgerKey(from))?.appearance()");
    expect(editor).toContain("pendingAppearance.set(manuscriptLedgerKey(to), now)");
  });

  test("**名前を変える前に呼ぶ**（あとでは画面がもう閉じている）", () => {
    const call = convert.indexOf("carryAppearanceToRenamed(plan.from, plan.to)");
    const rename = convert.indexOf("vscode.workspace.fs.rename(");
    expect(call).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(0);
    expect(call).toBeLessThan(rename);
  });

  test("**変換の唯一の口に置く**（1件でもフォルダーまるごとでも通る）", () => {
    // convertOne も convertFolder も renamePreservingContent を通る。
    // 呼び出し側それぞれに書くと、片方だけ直る日が来る
    expect(convert).toContain("export async function renamePreservingContent(");
    const body = convert.slice(
      convert.indexOf("export async function renamePreservingContent("),
      convert.indexOf("export async function importNotation(")
    );
    expect(body).toContain("carryAppearanceToRenamed(plan.from, plan.to)");

    // 呼び出し側には書かない（写しを作らない）
    const calls = convert.split("carryAppearanceToRenamed(").length - 1;
    // import の1回と、本体の1回だけ
    expect(calls).toBe(1);
  });
});
