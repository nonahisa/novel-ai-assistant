import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 原稿エディタの［次の話 →］［← 前の話］は、**その原稿エディタがいる列**に
 * 開く（2026-09-23、ノートPCの実機確認）。
 *
 * ## 何が起きていたか
 *
 * ［単話プロット］を押した直後に［次の話 →］を押すと、次の話が**右の列**
 * （単話プロットを開いた所）に開き、左は元の話のまま、右の単話プロットは
 * 隠れた。単話プロットは右の列（`ViewColumn.Beside`）に開いて前面になる。
 * 話の移動は `vscode.openWith` に列を渡しておらず、VS Code の既定どおり
 * **いま前面の列**へ開いていた。左の原稿を一度押してからなら正しく動くのは、
 * 前面が原稿の列へ戻るためである。
 *
 * ## どう直したか
 *
 * 移ってきた原稿（`from`）の画面が居る列（`panel.viewColumn`）を渡す。
 * 前面の列に依らない。
 *
 * ## このテストの性質
 *
 * 直したのは `vscode.openWith` へ渡す引数で、原稿エディタの画面ごとでないと
 * 動かせない。`manuscriptCarryAppearance.test.ts` と同じく、**配線が
 * 戻っていないこと**をソースの形で押さえる。
 */

function bodyOf(source: string, marker: string): string {
  const cleaned = source
    // コメントに書いた言葉で検査が通らないよう、先に落とす
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const start = cleaned.indexOf(marker);
  if (start === -1) throw new Error(`${marker} が見つかりません`);
  const open = cleaned.indexOf("{", cleaned.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}" && --depth === 0) return cleaned.slice(open, i + 1);
  }
  throw new Error(`${marker} の閉じ括弧が見つかりません`);
}

const editor = readFileSync("src/features/manuscriptEditor.ts", "utf8");

describe("話の移動は、原稿エディタのいる列に開く", () => {
  const body = bodyOf(editor, "private async openAsManuscript(");

  it("移ってきた原稿の画面の列を読む", () => {
    expect(body).toContain("manuscriptLedgerKey(from.uri)");
    expect(body).toContain(".panel.viewColumn");
  });

  it("その列を `vscode.openWith` へ渡す（前面の列に任せない）", () => {
    const call = body.slice(body.indexOf('"vscode.openWith"'));
    // 引数は4つ（コマンド名・場所・画面の種類・列）
    expect(call).toMatch(/"vscode\.openWith",\s*[^,]+,\s*this\.viewType,\s*column\s*\)/);
  });
});
