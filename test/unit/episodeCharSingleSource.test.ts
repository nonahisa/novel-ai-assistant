import { describe, expect, test } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { countEpisodeChars, episodeBodyForCount } from "../../src/core/episodeCharCount";

/**
 * 話の字数は、どの画面でも同じ関数で数える（実機確認リスト F-7・A-9 の代わり）。
 *
 * **作品一覧と原稿エディタが別々に数えていて、同じ話に2つの字数が出た**
 * （作者の指摘、2026-09-06）。数え方を `core/episodeCharCount.ts` の1つに
 * まとめたので、**そこを読んでいるか**と**写しが戻っていないか**を見張る。
 *
 * 画面を撮らずに済むのはここまでで、「下段に出ているか」は目で見るしかない。
 */

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("数え方の源は1つ", () => {
  test("作品一覧（走査）と原稿エディタが、同じ関数を読んでいる", () => {
    // 作品合計・話ごとの字数は走査（scanner）が数え、
    // 原稿エディタの下段「このファイル ◯字」は自分で数える。
    // **同じ import が両方に無ければ、どちらかが写しを持っている**
    for (const file of ["src/core/scanner.ts", "src/features/manuscriptEditor.ts"]) {
      expect(read(file), file + " が episodeCharCount を読んでいない").toContain(
        "countEpisodeChars"
      );
      expect(read(file), file + " の import が別の場所を指している").toMatch(
        /from "\.\.?\/core\/episodeCharCount"|from "\.\/episodeCharCount"/
      );
    }
  });

  test("話ごとの一覧は、走査が数えた値をそのまま並べる", () => {
    // 一覧（episodeCharTable）が自分で数え始めると、作品合計と食い違う
    const table = read("src/core/episodeCharTable.ts");

    expect(table).not.toContain("countChars(");
    expect(table).not.toContain("countEpisodeChars(");
  });

  /**
   * 生の `countChars` を直に呼んでよい場所を、名指しで固定する。
   *
   * ここに新しいファイルが増えたら、**話の字数を自前で数え始めた**という
   * ことである。増やすなら `episodeCharCount.ts` を通すか、
   * 「話の字数ではない」理由をここへ書く。
   */
  test("生の countChars を直に呼ぶのは、話の字数ではない場所だけ", () => {
    const allowed = new Set([
      // 定義そのもの
      "src/core/charCount.ts",
      // 話の字数の唯一の入り口
      "src/core/episodeCharCount.ts",
      // ステータスバー。**開いている文書そのもの**を数える（話の本文とは限らず、
      // プロットやメモでも出す）ので、頭書きを外す処理は通さない
      "src/extension.ts",
      // 競合の解決。どちらの版が長いかを見せるだけで、進捗には足さない
      "src/features/resolveConflicts.ts",
    ]);

    const callers = globSync("src/**/*.ts")
      .map((file) => file.split("\\").join("/"))
      .filter((file) => /\bcountChars\(/.test(read(file)));

    expect(callers.filter((file) => !allowed.has(file))).toEqual([]);
  });
});

describe("数え方そのもの", () => {
  test("カクヨム形式の頭書きと後書きは、話の字数に入れない", () => {
    const text = [
      "【タイトル】第1話 はじまり",
      "【文字数】999文字",
      "【本文】",
      "あいうえお",
      "【後書き】",
      "読んでくれてありがとう",
    ].join("\n");

    // 数えるのは本文の5字だけ
    expect(countEpisodeChars(text, { ext: ".txt", excludeRuby: true }).net).toBe(5);
    expect(episodeBodyForCount(text).trim()).toBe("あいうえお");
  });

  test("ルビと傍点を外すのは .md のときだけ", () => {
    const text = "{{強調}}と{漢字|かんじ}";

    // .md は拡張機能の記法として読む（「強調と漢字」の5字）
    expect(countEpisodeChars(text, { ext: ".md", excludeRuby: true }).net).toBe(5);
    // .txt は投稿サイトの記法をそのまま持っていることがあるので外さない
    // 印まで数えて15字（6＋1＋8）
    expect(countEpisodeChars(text, { ext: ".txt", excludeRuby: true }).net).toBe(15);
  });

  test("設定で「外さない」にすれば、.md でも印まで数える", () => {
    const text = "{{強調}}";

    expect(countEpisodeChars(text, { ext: ".md", excludeRuby: false }).net).toBe(6);
  });
});
