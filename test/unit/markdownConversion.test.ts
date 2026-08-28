import { describe, expect, test } from "vitest";
import {
  describeMarkdownSuggestion,
  describeRefusal,
  isPlainTextManuscript,
  planConversion,
  planFolderConversion,
  shouldSuggestMarkdown,
} from "../../src/core/markdownConversion";
import { countSiteNotation } from "../../src/core/ruby";

/**
 * .txt を .md へ変える判断（設計書6.12）。
 *
 * **ルビは .md でしか使えない。** 作者が .txt でルビを使おうとしたとき、
 * 断るだけでなく変換を提案する。
 *
 * **中身は1文字も変えず、名前だけを変える。** 読んで書き直すと、
 * 文字コードや改行の扱いを1つ間違えただけで原稿が壊れる。
 */
describe("本文のテキストか", () => {
  test.each(["episode_0001.txt", "C:/works/x/1.TXT"])("txtと見なす: %s", (f) => {
    expect(isPlainTextManuscript(f)).toBe(true);
  });

  test.each(["episode_0001.md", "設定/characters/a.json", "README"])(
    "txtではない: %s",
    (f) => {
      expect(isPlainTextManuscript(f)).toBe(false);
    }
  );
});

describe("1件の変換", () => {
  test("拡張子だけを .md に変える", () => {
    const decision = planConversion("C:/works/x/episode_0001.txt", [
      "episode_0001.txt",
    ]);

    expect(decision.plan).toEqual({
      from: "C:/works/x/episode_0001.txt",
      to: "C:/works/x/episode_0001.md",
    });
  });

  test("同じ名前の .md があれば断る", () => {
    // **上書きすれば、そちらに書いてあった本文が消える**
    const decision = planConversion("C:/works/x/episode_0001.txt", [
      "episode_0001.txt",
      "episode_0001.md",
    ]);

    expect(decision.plan).toBeUndefined();
    expect(decision.refusal).toBe("target_exists");
  });

  test("大文字小文字が違うだけの .md も、既にあると見なす", () => {
    // Windowsでは同じファイルを指す
    const decision = planConversion("C:/works/x/Episode_0001.txt", [
      "episode_0001.MD",
    ]);

    expect(decision.refusal).toBe("target_exists");
  });

  test("txtでなければ断る", () => {
    expect(planConversion("C:/works/x/a.md", []).refusal).toBe("not_text");
  });

  test("名前に点が複数あっても、最後の拡張子だけを変える", () => {
    expect(planConversion("C:/works/x/1.5話.txt", []).plan?.to).toBe(
      "C:/works/x/1.5話.md"
    );
  });
});

describe("フォルダーをまとめて変換", () => {
  test("全部の .txt を変換する", () => {
    const { plans, skipped } = planFolderConversion(
      ["C:/w/1.txt", "C:/w/2.txt"],
      ["1.txt", "2.txt"]
    );

    expect(plans.map((p) => p.to)).toEqual(["C:/w/1.md", "C:/w/2.md"]);
    expect(skipped).toHaveLength(0);
  });

  test("変換できないものだけ外して、残りは進める", () => {
    // **全部止めると、作者は何が悪いのか分からないまま先へ進めない**
    const { plans, skipped } = planFolderConversion(
      ["C:/w/1.txt", "C:/w/2.txt"],
      ["1.txt", "1.md", "2.txt"]
    );

    expect(plans.map((p) => p.to)).toEqual(["C:/w/2.md"]);
    expect(skipped).toEqual([
      { file: "C:/w/1.txt", refusal: "target_exists" },
    ]);
  });

  test("同じ回の中でぶつかるものも見つける", () => {
    // 「1.txt」と「1.TXT」が同居していると、変換先が同じになる
    const { plans, skipped } = planFolderConversion(
      ["C:/w/1.txt", "C:/w/1.TXT"],
      ["1.txt", "1.TXT"]
    );

    expect(plans).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  test("1件も無ければ空", () => {
    expect(planFolderConversion([], []).plans).toEqual([]);
  });
});

describe("断った理由の伝え方", () => {
  test("本文が消えることを言う", () => {
    expect(describeRefusal("target_exists")).toContain("本文が消えます");
  });

  test("どの理由も日本語で返る", () => {
    expect(describeRefusal("not_text")).toContain("テキストファイル");
  });
});

/**
 * 読み仮名の入った .txt を開いたときの案内（作者の指示、2026-08-29
 * 「読み仮名を含んだファイルを開くときは、理由を添えて、投稿には問題が
 * ない旨添えてファイルのMD変換を促しましょう」）。
 */
describe("MD化を勧めるか", () => {
  const none: string[] = [];

  test("読み仮名の入った .txt では勧める", () => {
    const counts = countSiteNotation("｜魔導書庫《まどうしょこ》へ向かう");

    expect(counts.ruby).toBeGreaterThan(0);
    expect(shouldSuggestMarkdown("C:/works/x/001.txt", counts, none)).toBe(true);
  });

  test("傍点だけでも勧める", () => {
    expect(
      shouldSuggestMarkdown("C:/works/x/001.txt", { ruby: 0, emphasis: 2 }, none)
    ).toBe(true);
  });

  test("読み仮名の無い .txt では出さない", () => {
    // 変換して得になることが無いのに声をかけると、案内が読まれなくなる
    expect(
      shouldSuggestMarkdown("C:/works/x/001.txt", { ruby: 0, emphasis: 0 }, none)
    ).toBe(false);
  });

  test(".md には出さない（もう変換されている）", () => {
    expect(
      shouldSuggestMarkdown("C:/works/x/001.md", { ruby: 5, emphasis: 0 }, none)
    ).toBe(false);
  });

  test("「今はしない」と断られたファイルには二度と出さない", () => {
    const counts = { ruby: 5, emphasis: 0 };

    expect(
      shouldSuggestMarkdown("C:/works/x/001.txt", counts, [
        "C:/works/x/001.txt",
      ])
    ).toBe(false);
    // 断ったのはそのファイルだけ。ほかの話では出す
    expect(
      shouldSuggestMarkdown("C:/works/x/002.txt", counts, [
        "C:/works/x/001.txt",
      ])
    ).toBe(true);
  });
});

describe("MD化を勧める文言", () => {
  test("件数と、投稿に問題が無いことを言う", () => {
    const text = describeMarkdownSuggestion({ ruby: 12, emphasis: 0 });

    expect(text).toContain("読み仮名（ルビ）が12件");
    // 0件のものは数え上げない（「傍点0件」と書いても読ませるだけ無駄）
    expect(text).not.toContain("傍点が");
    expect(text).toContain("投稿にも問題ありません");
    // なぜ勧めるのか（理由）を必ず添える
    expect(text).toContain("ルビや傍点を振り直せます");
  });

  test("傍点があれば、そちらも件数で言う", () => {
    const text = describeMarkdownSuggestion({ ruby: 3, emphasis: 2 });

    expect(text).toContain("読み仮名（ルビ）が3件と傍点が2件");
  });

  /**
   * **「中身は1文字も変わりません」とは書かない。** 名前を変えるだけでは
   * 済まず、中のルビ・傍点は拡張機能の書き方へ揃えられる（設計書6.12.4）。
   * 変わらないのは本文の言葉のほうである。
   */
  test("変わるものと変わらないものを、正確に言い分ける", () => {
    const text = describeMarkdownSuggestion({ ruby: 1, emphasis: 0 });

    expect(text).toContain("本文の言葉は1文字も変わりません");
    expect(text).not.toContain("中身は1文字も変わりません");
  });
});
