import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * 単話プロットの雛形が、**既にあるものを上書きしない**ことを見張る
 * （設計書6.36.2、実装ルール2「作者が書いたデータを上書きしない」）。
 *
 * 実機確認リストの「既にあれば上書きせず開くだけか」は、雛形の中身のほうは
 * `resumeSheet.test.ts` が確かめていたが、**上書きしない側は誰も見ていなかった**
 * （2026-09-21 に照合して分かった）。**ここは作者の原稿ではなく設定資料だが、
 * 作者が書き込んだ単話プロットを丸ごと雛形で潰す道**なので、被害の重さは
 * 本文と変わらない。
 *
 * `createEpisodePlotFile`（`src/features/resumeWriting.ts`）はエクスポート
 * されていないので、`switchModeWording.test.ts`・`dialogCancel.test.ts` と
 * 同じく**ソースを読んで関数の本体だけを調べる**形にする。
 *
 * **見ているのは「書き方の形」であって、動かした結果ではない。** 実際に
 * 既存ファイルが残ることの確認は実機側に残る。それでも、`mode` を
 * `"replace"` に変える・`pathExists` の門を外す、といった**この関数を
 * 危なくする書き換え**はここで止まる。
 *
 * 2026-09-21 追加。
 */

const SOURCE_PATH = path.join("src", "features", "resumeWriting.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

/**
 * コメントを取り除いてから、`createEpisodePlotFile` の本体だけを切り出す。
 *
 * **コメントを先に落とす。** 「上書きしない」と書いたコメントが本体に
 * 含まれていると、文字列を探すだけの検査が**コメントで通ってしまう。**
 */
function extractFunctionBody(src: string, startMarker: string): string {
  const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, "");

  const start = withoutLineComments.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      `${startMarker} が見つかりません。resumeWriting.ts の書き方が変わった可能性があります`
    );
  }

  // 開始の `{` から対応する閉じ `}` までを、波括弧の対応を数えて探す
  const braceStart = withoutLineComments.indexOf("{", start);
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
    throw new Error("createEpisodePlotFile の閉じ括弧が見つかりません");
  }

  return withoutLineComments.slice(braceStart, end + 1);
}

const body = extractFunctionBody(
  source,
  "async function createEpisodePlotFile("
);

describe("単話プロットの雛形は、既にあるものを上書きしない", () => {
  it("書き込みは新規作成（mode: \"create\"）だけを使う", () => {
    expect(body).toContain('mode: "create"');
    // `replace` は既存を書き換える道。**この関数には1つも無い**
    expect(body).not.toContain('mode: "replace"');
  });

  it("書き込みは1か所しかない", () => {
    // 逃げ道が増えると、片方だけ `create` のままになりうる
    const writes = body.match(/atomicWriteFile\s*\(/g) ?? [];
    expect(writes).toHaveLength(1);
  });

  it("書き込みの前に、既にあるかを確かめて抜ける", () => {
    const guard = body.indexOf("pathExists(");
    const write = body.indexOf("atomicWriteFile(");

    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    // **門が書き込みより前にある**こと。後ろにあっては意味がない
    expect(guard).toBeLessThan(write);
    // 門の中で抜けていること（`return` が門と書き込みのあいだにある）
    const escape = body.indexOf("return", guard);
    expect(escape).toBeGreaterThan(guard);
    expect(escape).toBeLessThan(write);
  });

  it("既にあるときは、そのまま開いたと作者へ伝える", () => {
    // 黙って何もしないと「押したのに何も起きない」になる
    expect(body).toContain("既にあります");
    expect(body).toContain("openInDefaultEditor(");
  });
});
