import { describe, expect, test } from "vitest";
import {
  buildRubyConfirm,
  countByTerm,
  planRubyInsertions,
  type RubyFileResult,
  type RubyTerm,
} from "../../src/core/settingsRuby";
import { describePendingUpdatesConfirm } from "../../src/features/applyPendingUpdates";
import { describeRenameScope } from "../../src/features/nameRename";

/**
 * 確認画面に出る数の整合（実機確認リスト A-10・A-14・F-11 の代わり）。
 *
 * **これまでは目で数えていた。** 「選んだ1話に、6件のルビを振りますか？」の
 * 6が、下に並ぶ話ごとの内訳・語ごとの件数と合っているかは、押す前に
 * 画面を撮って足し算するしかなかった（作者の指示、2026-09-08
 * 「手で確かめている項目のうち、機械にできるものを統合テストへ移して」）。
 *
 * 文言を組むところを純粋関数にしたので、**数が同じ配列から出ていること**を
 * ここで確かめる。画面に出た形（改行・字の並び）は目で見るしかない。
 */

describe("ルビを振る前の確認", () => {
  const terms: RubyTerm[] = [
    { text: "薬師寺", reading: "やくしじ" },
    { text: "焔火", reading: "ほむら" },
  ];

  /** 本文1つぶんの結果を、実際に振る手順どおりに作る */
  function resultOf(filePath: string, text: string): RubyFileResult {
    const insertions = planRubyInsertions(text, terms, "all");
    return {
      filePath,
      count: insertions.length,
      byTerm: countByTerm(insertions),
    };
  }

  const results = [
    resultOf("/work/01.md", "薬師寺と焔火。焔火はまだ薬師寺を見ている。"),
    resultOf("/work/02.md", "焔火が来た。"),
  ];

  const confirm = buildRubyConfirm({
    results,
    terms: { usable: terms, singleChar: [] },
    scopeLabel: "選んだ2話",
    fileName: (filePath) => filePath.split("/").pop() ?? filePath,
  });

  test("見出しの件数は、実際に振る件数の合計と同じ", () => {
    const total = results.reduce((sum, entry) => sum + entry.count, 0);

    expect(total).toBe(5);
    expect(confirm.title).toBe("選んだ2話に、5件のルビを振りますか？");
  });

  test("話ごとの内訳を足すと、見出しの件数になる", () => {
    // 「　01.md：3件」のような行から数だけを拾って足す
    const perFile = [...confirm.detail.matchAll(/：(\d+)件/g)].map((found) =>
      Number(found[1])
    );

    // 1話目は「薬師寺」2件と「焔火」2件、2話目は「焔火」1件
    expect(perFile).toEqual([4, 1]);
    expect(perFile.reduce((sum, count) => sum + count, 0)).toBe(5);
  });

  test("語ごとの件数を足しても、同じ数になる", () => {
    // 「　3件　焔火（ほむら）」の形。話ごとの行（「：3件」）とは書き方が違う
    const perTerm = [...confirm.detail.matchAll(/\n\s(\d+)件\s/g)].map((found) =>
      Number(found[1])
    );

    expect(perTerm.reduce((sum, count) => sum + count, 0)).toBe(5);
  });

  test("読み仮名のある名前の語数も、渡した一覧と同じ", () => {
    expect(confirm.detail).toContain(`読み仮名のある名前：${terms.length}語`);
  });

  test("1文字の語を外したときだけ、その断りが出る", () => {
    const withSingle = buildRubyConfirm({
      results,
      terms: { usable: terms, singleChar: [{ text: "因", reading: "いん" }] },
      scopeLabel: "選んだ2話",
      fileName: (filePath) => filePath,
    });

    expect(withSingle.detail).toContain("1文字の語（因）");
    // 外した語が無ければ、その行ごと出さない（読む量を増やさない）
    expect(confirm.detail).not.toContain("1文字の語");
  });

  test("戻し方は必ず添える（Ctrl+Z では戻らない）", () => {
    expect(confirm.detail).toContain("元に戻す");
  });
});

describe("更新分を反映する前の確認", () => {
  function entries(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      name: `人物${index + 1}`,
      change: "紹介文が変わりました",
    }));
  }

  test("人数と、並べた名前と、「ほか」の数が食い違わない", () => {
    const text = describePendingUpdatesConfirm(entries(7));

    expect(text).toContain("7 人の設定に更新があります。");
    // 並ぶのは5人まで。残りは数で示す（5＋2＝7）
    expect(text.match(/^・/gm)).toHaveLength(5);
    expect(text).toContain("…ほか 2 人");
  });

  test("5人までなら「ほか」は出ない", () => {
    const text = describePendingUpdatesConfirm(entries(5));

    expect(text).toContain("5 人の設定に更新があります。");
    expect(text.match(/^・/gm)).toHaveLength(5);
    expect(text).not.toContain("ほか");
  });

  test("1人でも数え方は同じ", () => {
    const text = describePendingUpdatesConfirm(entries(1));

    expect(text).toContain("1 人の設定に更新があります。");
    expect(text.match(/^・/gm)).toHaveLength(1);
  });
});

describe("名前を付け替える前の確認", () => {
  function issue(filePath: string) {
    return { filePath };
  }

  test("件数もファイル数も、同じ指摘の一覧から数える", () => {
    const issues = [
      issue("/work/01.md"),
      issue("/work/01.md"),
      issue("/work/02.md"),
      issue("/work/03.md"),
    ];

    expect(describeRenameScope(issues, "真田", "源")).toBe(
      "「真田」→「源」の置き換えを 4件、3ファイルで見つけました。"
    );
  });

  test("1ファイルに集まっていても、数え方は変わらない", () => {
    const issues = [issue("/work/01.md"), issue("/work/01.md")];

    expect(describeRenameScope(issues, "マル", "レオ")).toBe(
      "「マル」→「レオ」の置き換えを 2件、1ファイルで見つけました。"
    );
  });
});
