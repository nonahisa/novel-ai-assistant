import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { countForDisplay } from "../../src/features/manuscriptEditor";
import { countChars } from "../../src/core/charCount";
import { countEpisodeChars } from "../../src/core/episodeCharCount";

/**
 * 原稿エディタの「このファイル ◯字」は、**作品一覧とまったく同じ数え方**で
 * 数える（作者の裁定 2026-09-06、設計書6.25）。
 *
 * 作品一覧の第1話が 5,529字、原稿エディタの下段が「このファイル 5,672字」
 * と食い違った。差はカクヨム形式の頭書き（【タイトル】〜【本文】）である。
 * さらに**合本**（1ファイルに全話）では、作品一覧が話ごとに割って
 * 後書き・リアクションを落とすため、実データで約1万字ずれていた。
 *
 * 数え方は `core/episodeCharCount.ts` の1か所に集めてある（写しを作らない）。
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

/** 全話が1ファイルに入った形。後書き・リアクションが混ざっている */
const COLLECTED = [
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１話　転生",
  "",
  "【本文】",
  "気がつくと森の中だった。",
  "",
  "【後書き】",
  "読んでくれてありがとうございました。",
  "",
  "【リアクション】",
  "いいね: 19件",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２話　再会",
  "",
  "【本文】",
  "彼女は門の前に立っていた。",
].join("\n");

const WITH_RUBY = "{魔導書庫|まどうしょこ}へ向かう。";

describe("原稿エディタの字数", () => {
  test("合本は話ごとに割って数える（後書き・リアクションを足さない）", () => {
    // 作品一覧（`core/scanner.ts`）が数えているのは、この数字である
    expect(countForDisplay(COLLECTED, ".txt")).toBe(
      countEpisodeChars(COLLECTED, { ext: ".txt", excludeRuby: true }).net
    );
    // まとめて数えていた頃の数字とは、はっきり違う
    expect(countForDisplay(COLLECTED, ".txt")).toBeLessThan(
      countChars(COLLECTED, false).net
    );
  });

  test("頭書きのある単話は、本文だけを数える（作品一覧と同じ数字）", () => {
    expect(countForDisplay(WITH_HEADER, ".txt")).toBe(
      countChars("気がつくと森の中だった。", false).net
    );
    expect(countForDisplay(WITH_HEADER, ".txt")).toBeLessThan(
      countChars(WITH_HEADER, false).net
    );
  });

  test("頭書きの無い原稿は、これまでどおり全部を数える", () => {
    expect(countForDisplay(WITHOUT_HEADER, ".txt")).toBe(
      countChars(WITHOUT_HEADER, false).net
    );
  });

  test("【本文】が無ければ頭書きとみなさない（【】を飾りに使う原稿を守る）", () => {
    const decorated = "【重要】と彼は言った。";
    expect(countForDisplay(decorated, ".txt")).toBe(
      countChars(decorated, false).net
    );
  });

  test(".txt のルビ記法は外さない（作品一覧と同じ扱い）", () => {
    expect(countForDisplay(WITH_RUBY, ".txt")).toBe(
      countChars(WITH_RUBY, false).net
    );
  });

  test(".md はルビの読みを外す", () => {
    expect(countForDisplay(WITH_RUBY, ".md")).toBe(
      countChars("魔導書庫へ向かう。", false).net
    );
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
    // 0.37.4：シーンメモを落とすのは変換の側（convertForPosting）に移った。
    // ここでは「全文を渡さず、頭書きを除いた本文を渡す」ことだけを見る
    const call = source.match(/const source = sourceForPostingCopy\([\s\S]*?\);/);

    expect(call).not.toBeNull();
    expect(call?.[0]).toContain("document.getText()");
    // 0.48.1：合本なら、カーソルの居る1話だけを渡す（設計書6.12.1）。
    // **この画面は選択を渡す道が無い**ので、手で1話ぶんを選ぶ逃げ道も無い
    expect(call?.[0]).toContain("collected?.body");
    expect(source).toContain("collectedEpisodeAt(document.getText(), caretLine)");
    expect(source).toContain("convertForPosting(source, target)");
  });
});
