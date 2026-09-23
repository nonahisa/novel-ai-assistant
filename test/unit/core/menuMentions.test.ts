import { describe, expect, test } from "vitest";
import {
  BARE_MENTION_MIN_LENGTH,
  findMenuCommandByLabel,
  findMenuMentions,
  type MenuEntry,
} from "../../src/core/menuMentions";
import { menuEntries } from "../../src/views/actionList";

/**
 * AI の答えの中で名指しされたメニュー項目を拾う（設計書6.104。0.75.6）。
 *
 * **作者の指示（2026-09-22）**：「AIからの回答で点滅すると良い」。
 *
 * ここで見張りたいのは3つ。
 *
 * 1. **短い語を素の一致で拾わない。** 「推敲」「年表」は本文の話題として
 *    ふつうに出てくるので、話しただけで項目が光ると押す場所と誤解される
 * 2. **長いラベルが、短いラベルに食われない。** 「矛盾検知」と
 *    「矛盾検知（事実の照合）」のように片方が片方を含む名前が実在する
 * 3. **同じ項目を1つに畳み、出てきた順に返す**
 */

const ITEMS: readonly MenuEntry[] = [
  { label: "推敲", command: "novelai.runProofread" },
  { label: "誤字脱字検知", command: "novelai.checkTypos" },
  { label: "矛盾検知", command: "novelai.checkContradictions" },
  { label: "矛盾検知（事実の照合）", command: "novelai.checkFacts" },
];

describe("囲まれていれば、短い語でも拾う", () => {
  test("かぎ括弧", () => {
    expect(findMenuMentions("まず「推敲」を押してください。", ITEMS)).toEqual([
      { label: "推敲", command: "novelai.runProofread" },
    ]);
  });

  test("太字（Markdown）", () => {
    expect(findMenuMentions("まず **推敲** を押します。", ITEMS)).toEqual([
      { label: "推敲", command: "novelai.runProofread" },
    ]);
  });

  test("コード引用（バッククォート）", () => {
    // **組み立てて作る。** テンプレート文字列の中に書くと構文が壊れ、
    // 素の文字列に書くと読む人がテンプレート文字列と見間違える
    const quote = String.fromCharCode(96);
    const text = "まず " + quote + "推敲" + quote + " を押します。";
    expect(findMenuMentions(text, ITEMS)).toEqual([
      { label: "推敲", command: "novelai.runProofread" },
    ]);
  });
});

describe("囲まれていなければ、短い語は拾わない", () => {
  test("素の「推敲」は本文の話題なので拾わない", () => {
    expect(
      findMenuMentions("推敲についてお話しします。推敲とは……", ITEMS)
    ).toEqual([]);
  });

  test("5文字以上のラベルは、囲みが無くても拾う", () => {
    expect("誤字脱字検知".length).toBeGreaterThanOrEqual(
      BARE_MENTION_MIN_LENGTH
    );
    expect(findMenuMentions("誤字脱字検知を先に走らせましょう。", ITEMS)).toEqual(
      [{ label: "誤字脱字検知", command: "novelai.checkTypos" }]
    );
  });
});

describe("長いラベルを先に当てる", () => {
  test("含んでいる側が勝ち、短いほうは二重に拾われない", () => {
    const found = findMenuMentions(
      "矛盾検知（事実の照合）を試してください。",
      ITEMS
    );
    expect(found).toEqual([
      { label: "矛盾検知（事実の照合）", command: "novelai.checkFacts" },
    ]);
  });

  test("別の場所に短いほうが出ていれば、そちらは拾う", () => {
    // 短いほう（4文字）は囲まないと拾われないので、囲んで置く
    const found = findMenuMentions(
      "矛盾検知（事実の照合）のあとで、「矛盾検知」も走らせます。",
      ITEMS
    );
    expect(found.map((one) => one.command)).toEqual([
      "novelai.checkFacts",
      "novelai.checkContradictions",
    ]);
  });
});

describe("畳み方と並び", () => {
  test("同じ項目は1つに畳む", () => {
    const found = findMenuMentions(
      "誤字脱字検知を押し、そのあと誤字脱字検知の結果を見ます。",
      ITEMS
    );
    expect(found).toHaveLength(1);
  });

  test("出てきた順に返す（長さの順ではない）", () => {
    const found = findMenuMentions(
      "先に「推敲」、そのあと誤字脱字検知です。",
      ITEMS
    );
    expect(found.map((one) => one.command)).toEqual([
      "novelai.runProofread",
      "novelai.checkTypos",
    ]);
  });

  test("何も名指ししていない答えでは、空", () => {
    expect(findMenuMentions("そうですね、面白いと思います。", ITEMS)).toEqual(
      []
    );
    expect(findMenuMentions("", ITEMS)).toEqual([]);
    expect(findMenuMentions("推敲", [])).toEqual([]);
  });
});

describe("ラベルを名指しで引く（外部AIの label）", () => {
  test("完全一致だけを引く", () => {
    expect(findMenuCommandByLabel("推敲", ITEMS)).toBe("novelai.runProofread");
    // **部分一致で当てにいかない**（頼んでいない項目が光る）
    expect(findMenuCommandByLabel("矛盾", ITEMS)).toBeUndefined();
    expect(findMenuCommandByLabel("", ITEMS)).toBeUndefined();
  });

  test("前後の空白は落とす", () => {
    expect(findMenuCommandByLabel("  推敲 ", ITEMS)).toBe(
      "novelai.runProofread"
    );
  });
});

describe("本物のメニューと繋がっている", () => {
  test("実在のラベルで引ける（照合先が空でない）", () => {
    const entries = menuEntries();
    expect(entries.length).toBeGreaterThan(50);
    // 名前とコマンドIDが両方入っていること（片方だけでは照合できない）
    expect(entries.every((one) => one.label && one.command)).toBe(true);
    const sample = entries.find(
      (one) => one.command === "novelai.checkContradictions"
    );
    expect(sample, "矛盾検知が一覧に無い（この試験の前提が変わった）").toBeDefined();
    expect(findMenuCommandByLabel(sample!.label, entries)).toBe(
      "novelai.checkContradictions"
    );
  });
});
