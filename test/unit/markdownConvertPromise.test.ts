import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * **MD化の案内に、できない約束を書かない**（設計書6.12.4）。
 *
 * 作者の実機報告（2026-09-08）：案内文3か所が「中身は1文字も変えません」
 * 「戻したくなったら、名前を .txt に戻すだけで元どおりです」と言っているが、
 * **どちらも事実と違う。**
 *
 * 0.16.0 から、MD化は投稿サイトの書き方のルビ・傍点
 * （`｜漢字《かんじ》`・`《《強調》》`）を、この拡張機能の書き方へ直す。
 * つまり**本文のバイトが変わる。** 名前を `.txt` へ戻しても、
 * `{漢字|かんじ}` は `｜漢字《かんじ》` には戻らない。
 *
 * **作者の原稿についての約束である。** 「元どおりになる」と読んで変換した人が、
 * 戻せないと気づくのは戻そうとしたときで、そのときにはもう遅い。
 * 0.51.6 で、実際の動きに合わせて書き直した。
 *
 * 案内は3つのファイルに散っているので（選ぶ画面・確認・メニューの説明・
 * ルビを振ろうとしたときの案内）、**まとめてここで見張る**。
 */

const FILES = [
  "src/features/markdownConvert.ts",
  "src/views/actionList.ts",
  "src/features/ruby.ts",
  // 0.51.8 で5か所目が見つかった（`.txt` でルビを押したときの断り）
  "src/features/manuscriptEditor.ts",
];

/** 案内の文言だけを見る（注釈は除く） */
function messagesOf(relative: string): string {
  const source = readFileSync(resolve(__dirname, "../..", relative), "utf8");
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
}

describe("MD化の案内", () => {
  test("**「中身は1文字も変えません」と言わない**", () => {
    // 言ってよいのは「字そのものは変えない」までで、
    // 記法は直る（そこが変わることを隠さない）
    for (const file of FILES) {
      // **言い回しの揺れも見る。** 0.51.6 で「変えません」の形だけを
      // 見張ったせいで、「中身は1文字も**変わりません**」と書いてある
      // 5か所目を見落とした（0.51.8 で見つけた）
      for (const phrase of [
        "中身は1文字も変えません",
        "中身は1文字も変えず",
        "中身は変えず",
        "中身は1文字も変わりません",
        "中身は変わりません",
      ]) {
        expect(messagesOf(file), `${file} / ${phrase}`).not.toContain(phrase);
      }
    }
  });

  test("**「名前を .txt に戻すだけで元どおり」と言わない**", () => {
    // 記法が書き換わっているので、名前を戻しても元には戻らない
    for (const file of FILES) {
      expect(messagesOf(file), file).not.toContain(".txt に戻すだけで元どおり");
      expect(messagesOf(file), file).not.toContain(".txt に戻すだけです");
    }
  });

  test("ルビ・傍点を直すことを、案内が言っている", () => {
    const convert = messagesOf("src/features/markdownConvert.ts");
    expect(convert).toContain("ルビ・傍点");
    // 何が起きるのかと、控えが残ることの両方を言う
    expect(convert).toContain(".novelai-recovery");
  });

  test("文字コードと改行はそのまま、とは言ってよい（事実である）", () => {
    // `renamePreservingContent` は名前しか変えず、
    // `importNotation` は writeTextFilePreservingFormat を通す
    const convert = messagesOf("src/features/markdownConvert.ts");
    expect(convert).toContain("文字コードと改行はそのまま");
  });
});
