import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * 原稿エディターの右クリックから「執筆を再開」を呼ぶ（設計書6.25・6.36。
 * 作者の依頼、2026-09-23「原稿エディター内でも呼び出せたらいいな」）。
 *
 * 画面が送る知らせ（`views/manuscriptEditorHtml.ts` の `resumeWriting`）を、
 * 原稿エディターが受けて `extension.ts` の繋ぎへ渡すまでを、書き方で押さえる。
 * **どれか1つが抜けると、押しても何も起きない項目になる**——画面の組み立ては
 * 単体で見られても、受け口の抜けは画面を押すまで気づけない。
 *
 * 作品は**開いている原稿の作品**を使う。コマンドを引数なしで呼ぶと、
 * 作品が複数あるときに「どの作品か」を訊き直してしまう。
 */

const SRC = join(__dirname, "..", "..", "..", "src");
const read = (file: string): string => readFileSync(join(SRC, file), "utf8");

describe("原稿エディターから執筆再開を呼ぶ繋ぎ", () => {
  test("原稿エディターが画面からの知らせを受け、繋ぎへ渡す", () => {
    const source = read("features/manuscriptEditor.ts");
    expect(source).toContain('| { type: "resumeWriting" }');
    const at = source.indexOf('case "resumeWriting":');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 200)).toContain(
      "this.deps.resumeWriting?.(fromUri(document.uri))"
    );
  });

  test("extension.ts が、原稿の作品を引いて執筆再開を開く", () => {
    const source = read("extension.ts");
    const at = source.indexOf("resumeWriting: async (filePath)");
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 800);
    expect(body).toContain("workOfPath(registry, filePath)");
    // コマンドを通す（失敗の知らせと「動いている」札をメニューと揃える）
    expect(body).toContain('"novelai.resumeWriting"');
    expect(body).toContain('{ type: "work", work }');
  });
});
