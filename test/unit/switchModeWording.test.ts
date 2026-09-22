import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * 「編集者にする／作者に戻す」の説明文を見張る（設計書5.6.1、実機確認リスト）。
 *
 * 実機確認リストで「`**` が出ていないか」を人が見て確かめた項目だが、
 * 文言が変わったら誰も止めないので、機械の見張りを置いた（2026-09-21）。
 *
 * `describe()`（`src/features/switchMode.ts`）はエクスポートされていないので、
 * `dialogCancel.test.ts` の「取りやめ方を、製品からは書かない」と同じく
 * ソースを読んで文字列リテラルを調べる形にする。
 */

const SOURCE_PATH = path.join("src", "features", "switchMode.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

/** コメント（/** … *\/ と //）を取り除いてから、関数本体の範囲だけを切り出す */
function extractDescribeBody(src: string): string {
  // コメントの中の ** は画面へ出ないので対象外。先に取り除く
  const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, "");

  const startMarker = "function describe(next: WorkMode): string {";
  const start = withoutLineComments.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      "describe() の開始位置が見つかりません。switchMode.ts の書き方が変わった可能性があります"
    );
  }

  // 開始の `{` から対応する閉じ `}` までを、波括弧の対応を数えて探す
  const braceStart = start + startMarker.length - 1;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < withoutLineComments.length; i++) {
    const ch = withoutLineComments[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error("describe() の閉じ括弧が見つかりません");
  }

  return withoutLineComments.slice(braceStart, end + 1);
}

const describeBody = extractDescribeBody(source);

describe("「編集者にする」の説明", () => {
  it("強調の ** が画面へ出ない", () => {
    // Markdown の強調記法は VS Code のダイアログでは生の記号のまま出る
    expect(describeBody).not.toContain("**");
  });

  it("【できること】【できなくなること】の見出しがある", () => {
    expect(describeBody).toContain("【できること】");
    expect(describeBody).toContain("【できなくなること】");
  });
});

describe("「作者に戻す」の説明", () => {
  it("こちらの分岐にも ** が出ない", () => {
    // describe("author") 側の分岐。describeBody は next === "author" と
    // next === "editor" の両方の分岐を含む関数本体全体なので、
    // ここまでの検査で両方の分岐がすでに含まれている
    expect(describeBody).not.toContain("**");
  });
});
