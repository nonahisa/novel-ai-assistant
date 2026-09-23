import { describe, expect, test } from "vitest";
import { Bm25Index, bigrams } from "../../src/core/bm25";
import {
  describeRetrieval,
  formatForPrompt,
  retrieve,
} from "../../src/core/retrieval";
import { splitPassages } from "../../src/core/retrievalCorpus";
import type { RetrievalItem } from "../../src/core/retrievalCorpus";
import {
  buildSearchQuery,
  parseSearchTerms,
} from "../../src/prompts/searchTerms";

function item(
  id: string,
  text: string,
  overrides: Partial<RetrievalItem> = {}
): RetrievalItem {
  return {
    id,
    source: "本文",
    label: id,
    text,
    hash: id,
    authorWritten: false,
    ...overrides,
  };
}

describe("文字2つ組み", () => {
  test("空白と改行は落とす", () => {
    // 小説は改行が多く、残すと「。\n「」ばかりが増えて判定が鈍る
    expect(bigrams("あ い\nう")).toEqual(["あい", "いう"]);
  });

  test("1文字では組みが作れない", () => {
    expect(bigrams("あ")).toEqual([]);
  });
});

describe("語句一致（BM25）", () => {
  const index = new Bm25Index([
    { id: "a", text: "彼女は嫉妬に顔をゆがめた" },
    { id: "b", text: "道場で稽古を重ねる日々" },
    { id: "c", text: "傷口を洗うための薬を調合した" },
  ]);

  test("含む語で引ける", () => {
    expect(index.search("嫉妬", 3)[0].id).toBe("a");
  });

  test("一致が無い文書は返さない", () => {
    // 0点を混ぜると、上位n件に無関係な場面が紛れ込む
    expect(index.search("宇宙船", 3)).toEqual([]);
  });

  test("件数の上限を守る", () => {
    expect(index.search("を", 2).length).toBeLessThanOrEqual(2);
  });

  test("母集団を渡すと、その外の文書は返らない", () => {
    // 相談は mustInclude で母集団を狭める。索引全体から引いてから
    // ふるいにかけると、母集団の文書が上位に残らず取りこぼす（設計書6.27.6）
    const got = index.search("嫉妬 稽古 薬", 3, new Set(["b"]));

    expect(got.map((hit) => hit.id)).toEqual(["b"]);
  });

  test("件数の上限は、母集団で絞ったあとに効く", () => {
    // 「全体の上位n件のうち母集団に入るもの」ではなく
    // 「母集団の中の上位n件」を返す。ここが取りこぼしの分かれ目
    const many = new Bm25Index(
      Array.from({ length: 10 }, (_, i) => ({
        id: `d-${i}`,
        text: `${"あ".repeat(i)}嫉妬の場面`,
      }))
    );
    const allowed = new Set(["d-5", "d-6", "d-7", "d-8", "d-9"]);
    const got = many.search("嫉妬", 3, allowed);

    expect(got).toHaveLength(3);
    for (const hit of got) expect(allowed.has(hit.id)).toBe(true);
  });

  test("母集団を渡さなければ、これまでどおり", () => {
    expect(index.search("嫉妬", 3).map((hit) => hit.id)).toEqual(["a"]);
    expect(index.search("宇宙船", 3, undefined)).toEqual([]);
  });
});

describe("検索の組み立て", () => {
  const items = [
    item("1", "彼女は嫉妬に顔をゆがめた"),
    item("2", "道場で稽古を重ねる"),
    item("3", "傷口を洗う薬を調合した"),
    item("4", "まったく関係のない場面"),
  ];
  const bm25 = new Bm25Index(items.map((i) => ({ id: i.id, text: i.text })));

  test("意味検索が無くても語句一致だけで動く", () => {
    // 非力な機械ではベクトルDBを切る。そのとき何も返せないと使えない
    const got = retrieve({ items, bm25, query: "嫉妬" }, { maxChars: 1000 });

    expect(got.length).toBeGreaterThan(0);
    expect(got[0].item.id).toBe("1");
    expect(got[0].foundBy).toBe("語句一致");
  });

  test("どちらでも見つからなければ空を返す", () => {
    // 苦し紛れに冒頭を返すと「関係のある場面が見つかった」と誤解させる
    expect(retrieve({ items, bm25, query: "宇宙船" }, { maxChars: 1000 })).toEqual(
      []
    );
  });

  test("文字数の上限で切る", () => {
    const got = retrieve({ items, bm25, query: "場面 嫉妬 稽古 薬" }, { maxChars: 30 });
    const total = got.reduce((sum, c) => sum + c.item.text.length, 0);

    expect(total).toBeLessThanOrEqual(30);
  });

  test("1件目が上限を超えても、1件は渡す", () => {
    const long = [item("x", "あ".repeat(500))];
    const got = retrieve(
      { items: long, bm25: new Bm25Index([{ id: "x", text: long[0].text }]), query: "あああ" },
      { maxChars: 10 }
    );

    expect(got).toHaveLength(1);
  });

  test("出どころで絞れる", () => {
    const mixed = [
      item("m1", "嫉妬の場面"),
      item("s1", "嫉妬という感情の説明", { source: "設定資料" }),
    ];
    const index = new Bm25Index(mixed.map((i) => ({ id: i.id, text: i.text })));
    const got = retrieve(
      { items: mixed, bm25: index, query: "嫉妬" },
      { maxChars: 1000, sources: ["設定資料"] }
    );

    expect(got.map((c) => c.item.id)).toEqual(["s1"]);
  });

  test("指定の語を含む材料だけに絞れる", () => {
    // 人物の相談では、その人が出てくる場面に限りたい
    const mixed = [
      item("m1", "マイナは嫉妬した"),
      item("m2", "別の誰かが嫉妬した"),
    ];
    const index = new Bm25Index(mixed.map((i) => ({ id: i.id, text: i.text })));
    const got = retrieve(
      { items: mixed, bm25: index, query: "嫉妬" },
      { maxChars: 1000, mustInclude: ["マイナ"] }
    );

    expect(got.map((c) => c.item.id)).toEqual(["m1"]);
  });

  test("母集団を狭めた相談でも、語句一致が取りこぼさない", () => {
    // 設計書6.27.6の穴4の再現。
    //
    // 以前は索引**全体**から perMethod*3（既定60）件引いてから allowed で
    // ふるいにかけていた。質問語を強く含む場面が他に70件あると、目当ての
    // 1件は全体では71位で、上位60件に入らない。ふるいの結果は0件になり、
    // 語句一致が丸ごと空になる（意味検索を切っていれば結果も空）。
    //
    // 「母集団の中の上位n件」を引けば、この1件は1位で返る。
    const noise = Array.from({ length: 70 }, (_, i) =>
      item(`n-${i}`, "嫉妬。嫉妬。嫉妬。")
    );
    // 目当ての1件は、質問語を1回しか含まず、長いので点が最も低くなる
    const target = item(
      "target",
      `マイナ${"あ".repeat(300)}嫉妬${"い".repeat(300)}`
    );
    const all = [...noise, target];
    const index = new Bm25Index(all.map((i) => ({ id: i.id, text: i.text })));

    // 前提の確認：全体で引くと、目当ての1件は上位60件に入らない
    expect(index.search("嫉妬", 60).map((h) => h.id)).not.toContain("target");

    const got = retrieve(
      { items: all, bm25: index, query: "嫉妬" },
      { maxChars: 5000, mustInclude: ["マイナ"] }
    );

    expect(got.map((c) => c.item.id)).toEqual(["target"]);
    expect(got[0].foundBy).toBe("語句一致");
  });
});

describe("AIへ渡す形", () => {
  test("出どころを必ず書く", () => {
    // 設定資料は本文からAIが作ったもので、本文と対等な証言ではない。
    // 実データで、設定資料の誤りがAIの答えへ入り込んだ例がある
    const text = formatForPrompt([
      { item: item("s", "祖母である", { source: "設定資料", label: "登場人物: ばあさん" }), foundBy: "語句一致" },
    ]);

    expect(text).toContain("《設定資料／登場人物: ばあさん》");
  });

  test("作者が書いた記述には印を付ける", () => {
    // ここだけがAIの抽出と独立した経路になる
    const text = formatForPrompt([
      {
        item: item("s", "作者のメモ", { source: "設定資料", authorWritten: true }),
        foundBy: "語句一致",
      },
    ]);

    expect(text).toContain("・作者記述");
  });

  test("何を参照したかを短く説明できる", () => {
    const summary = describeRetrieval([
      { item: item("a", "x"), foundBy: "語句一致" },
      { item: item("b", "y", { source: "あらすじ" }), foundBy: "意味検索" },
    ]);

    expect(summary).toContain("本文1件");
    expect(summary).toContain("あらすじ1件");
  });

  test("見つからなかったことも言葉にする", () => {
    expect(describeRetrieval([])).toContain("見つかりません");
  });
});

describe("本文の切り分け", () => {
  test("行の途中では切らない", () => {
    // 小説は1行が短く、途中で切ると台詞が半分になって読めなくなる
    const text = Array.from({ length: 12 }, (_, i) => `${i}行目のせりふです。`).join(
      "\n"
    );
    const passages = splitPassages(text, 60, 10);

    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      for (const line of passage.split("\n")) {
        expect(text.includes(line)).toBe(true);
      }
    }
  });

  test("短い本文は1つのまま", () => {
    expect(splitPassages("短い本文。")).toEqual(["短い本文。"]);
  });

  test("空の本文は0件", () => {
    expect(splitPassages("\n\n")).toEqual([]);
  });
});

describe("質問を検索語に直す", () => {
  test("応答から検索語を取り出す", () => {
    expect(parseSearchTerms('{"terms":["嫉妬","羨む"]}')).toEqual(["嫉妬", "羨む"]);
  });

  test("コードフェンス付きでも読める", () => {
    expect(parseSearchTerms('```json\n{"terms":["稽古"]}\n```')).toEqual(["稽古"]);
  });

  test("壊れていても例外にしない", () => {
    // 検索語が作れなくても、質問文そのままで検索すれば動く。
    // ここで止めると相談ができなくなる
    expect(parseSearchTerms("こわれた応答")).toEqual([]);
  });

  test("長すぎる語は落とす（文を返してきたとき）", () => {
    expect(parseSearchTerms(`{"terms":["${"あ".repeat(40)}","嫉妬"]}`)).toEqual([
      "嫉妬",
    ]);
  });

  test("質問文も検索に残す", () => {
    // 検索語が的外れだったときの手がかりを残すため
    const query = buildSearchQuery("妬んでいる場面は？", ["嫉妬"], "マイナ");

    expect(query).toContain("マイナ");
    expect(query).toContain("妬んでいる場面は？");
    expect(query).toContain("嫉妬");
  });
});
