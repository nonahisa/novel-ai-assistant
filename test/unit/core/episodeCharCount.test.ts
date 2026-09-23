import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  countEpisodeChars,
  episodeBodyForCount,
} from "../../src/core/episodeCharCount";
import { countChars } from "../../src/core/charCount";

/**
 * 話の字数の数え方（作者の裁定 2026-09-06、設計書6.25）。
 *
 * 作品一覧（`core/scanner.ts`）は、合本を話ごとに割ってから数え、
 * 後書き・リアクション（作者の物語ではない文章）を落としている。
 * 原稿エディタの「このファイル ◯字」が同じ数え方をしていなかったため、
 * 実データの合本で約1万字ずれた。**数え方はこの1か所に集める。**
 */

/** なろうのダウンロードツールが出す合本の形（`collectedFile.ts` の説明どおり） */
const COLLECTED = [
  "------------------------- エピソード1開始 -------------------------",
  "【第1章】",
  "第一章『死の谷』",
  "",
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
  "",
  "【リアクション】",
  "いいね: 3件",
].join("\n");

/** カクヨム形式の頭書きが付いた単話 */
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

const PLAIN = ["気がつくと森の中だった。", "", "空は高い。"].join("\n");

/** ルビ記法（Markdown形式）を含む本文 */
const WITH_RUBY = "{魔導書庫|まどうしょこ}へ向かう。";

describe("数える対象の本文", () => {
  test("合本は話ごとに割り、後書き・リアクション・章題を落とす", () => {
    expect(episodeBodyForCount(COLLECTED)).toBe(
      "気がつくと森の中だった。\n彼女は門の前に立っていた。"
    );
  });

  test("単話の頭書き（【タイトル】〜【本文】）は数えない", () => {
    expect(episodeBodyForCount(WITH_HEADER)).toBe("気がつくと森の中だった。");
  });

  test("頭書きの無い原稿は、全文がそのまま対象になる", () => {
    expect(episodeBodyForCount(PLAIN)).toBe(PLAIN);
  });
});

describe("ルビの扱い", () => {
  test(".md のときだけルビの読みを外す", () => {
    const md = countEpisodeChars(WITH_RUBY, { ext: ".md", excludeRuby: true });
    expect(md.net).toBe(countChars("魔導書庫へ向かう。", false).net);
  });

  test(".txt はルビ記法をそのまま数える（作品一覧と同じ）", () => {
    const txt = countEpisodeChars(WITH_RUBY, { ext: ".txt", excludeRuby: true });
    expect(txt.net).toBe(countChars(WITH_RUBY, false).net);
  });

  test("設定で外さないと決めていれば .md でも外さない", () => {
    const md = countEpisodeChars(WITH_RUBY, { ext: ".md", excludeRuby: false });
    expect(md.net).toBe(countChars(WITH_RUBY, false).net);
  });
});

/**
 * 写しを作らないこと。作品一覧と原稿エディタが別々に数え始めた結果、
 * 同じファイルに2つの字数が出た。**同じ関数を通っていることを見張る。**
 */
describe("数え方の置き場所", () => {
  const read = (...parts: string[]): string =>
    readFileSync(path.join(__dirname, "..", "..", ...parts), "utf8");

  test("作品一覧（scanner）は countEpisodeChars を通す", () => {
    const source = read("src", "core", "scanner.ts");
    expect(source).toContain("countEpisodeChars");
    // 自前で `countChars` を呼び直していないこと
    expect(source).not.toContain("countChars(");
  });

  test("原稿エディタも同じ関数を通す", () => {
    const source = read("src", "features", "manuscriptEditor.ts");
    expect(source).toContain("countEpisodeChars");
    expect(source).not.toContain("countChars(");
  });
});
