import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { countForDisplay } from "../../src/features/manuscriptEditor";
import { countChars } from "../../src/core/charCount";
import { extractEpisodeParts } from "../../src/core/episodeCopy";

/**
 * 原稿エディタの「このファイル ◯字」は、**本文だけを数える**
 * （作者の裁定 2026-09-06、設計書6.25）。
 *
 * 作品一覧の第1話が 5,529字、原稿エディタの下段が「このファイル 5,672字」
 * と食い違った。差はカクヨム形式の頭書き（【タイトル】〜【本文】）で、
 * **作品一覧は頭書きを外してから数えている**（`core/scanner.ts`）。
 * 同じファイルに2つの数字が出ると、どちらが本当か分からない。
 *
 * 頭書きの切り方は `core/episodeCopy.ts` の `extractEpisodeParts` に
 * 集めてある（写しを作らない）。
 */
const WITH_HEADER = [
  "【タイトル】",
  "第一話　転生",
  "",
  "【公開状態】",
  "公開",
  "",
  "【文字数】",
  "12文字",
  "",
  "【本文】",
  "気がつくと森の中だった。",
].join("\n");

const WITHOUT_HEADER = ["気がつくと森の中だった。", "", "空は高い。"].join("\n");

describe("原稿エディタの字数", () => {
  test("頭書きのある原稿は、本文だけを数える（作品一覧と同じ数字）", () => {
    const body = extractEpisodeParts(WITH_HEADER, null).body;
    // 作品一覧（`core/scanner.ts`）が数えているのは、この本文である
    expect(countForDisplay(WITH_HEADER)).toBe(countChars(body).net);
    // 頭書きごと数えていた頃の数字とは、はっきり違う
    expect(countForDisplay(WITH_HEADER)).toBeLessThan(
      countChars(WITH_HEADER).net
    );
  });

  test("頭書きの無い原稿は、これまでどおり全部を数える", () => {
    expect(countForDisplay(WITHOUT_HEADER)).toBe(
      countChars(WITHOUT_HEADER).net
    );
  });

  test("【本文】が無ければ頭書きとみなさない（【】を飾りに使う原稿を守る）", () => {
    const decorated = "【重要】と彼は言った。";
    expect(countForDisplay(decorated)).toBe(countChars(decorated).net);
  });
});

/**
 * 「投稿サイト用に変換してコピー」も、頭書きを外す（設計書6.12.1）。
 *
 * 普通のエディタ側（`features/ruby.ts`）は 0.35.2 で
 * `sourceForPostingCopy` を通すようにしたが、**原稿エディタだけが
 * `document.getText()` の全文のまま**残っていた。貼ると題名の行から
 * 二重に入る。
 *
 * この経路は画面（WebviewPanel）とクリップボードを跨ぐので単体では
 * 動かせない。**通っている道を、書いてあるコードの形で見る。**
 */
describe("投稿サイト用のコピー", () => {
  test("原稿エディタも sourceForPostingCopy を通す（全文を渡さない）", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "..", "src", "features", "manuscriptEditor.ts"),
      "utf8"
    );
    const call = source.match(/const source = stripMemoLines\([\s\S]*?\);/);

    expect(call).not.toBeNull();
    expect(call?.[0]).toContain("sourceForPostingCopy(document.getText())");
  });
});
