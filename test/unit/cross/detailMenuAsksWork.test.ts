import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 詳細メニューから押した命令は、作品を毎回選ばせる（作者の判断 2026-11-02）。
 *
 * 印を渡す側（`views/actionList.ts`）と並べる関数（`core/workTarget.ts`）は
 * それぞれの試験で見ている。ここでは **`activate` の中の繋ぎ**——包みが印を外し、
 * 作品を決める所が推し量りを飛ばす——を、ソースの形で確かめる。`activate` は
 * 単体で動かせないので、繋ぎを外す書き換えが入ったら気づけるようにする。
 */
const source = readFileSync(
  resolve(__dirname, "../../../src/extension.ts"),
  "utf8"
);

describe("詳細メニューから押したら作品を選ばせる繋ぎ", () => {
  test("コマンド登録の包みが印を外し、本体へ引数なしで届ける", () => {
    expect(source).toMatch(
      /const fromDetailMenu = isDetailMenuArgs\(args\[0\]\);\s*if \(fromDetailMenu\) args = \[undefined, \.\.\.args\.slice\(1\)\];/
    );
  });

  test("相談から光らせた項目を押した1回は、選ばせない", () => {
    expect(source).toMatch(
      /fromDetailMenu && litWork === undefined \? \{\} : undefined/
    );
  });

  test("作品を決める所は、印があれば推し量らずに選ぶ画面を出す", () => {
    const body = source.slice(
      source.indexOf("async function resolveWorkUnrouted("),
      source.indexOf("async function resolveWorkUnrouted(") + 6000
    );
    expect(body).toContain("const askFromMenu = detailMenuAsk !== undefined;");
    expect(body).toContain("orderByLikelyWork(works, likelyWorkHints?.() ?? {})");
    expect(body).toContain("describeLikelyWorkReason(reason)");
  });

  test("前提の関門も、印があれば開いているファイルで作品を決めない", () => {
    expect(source).toContain(
      "vscode.window.activeTextEditor && detailMenuAsk === undefined"
    );
  });
});
