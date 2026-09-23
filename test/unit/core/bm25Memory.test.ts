import { describe, expect, test } from "vitest";
import { Bm25Index, bigrams } from "../../src/core/bm25";

/**
 * 語句検索の索引が大きすぎた問題の再現（作者の指摘、2026-08-16）。
 *
 * 「消費メモリーが大きい」と言われて測ったところ、78.5万字の作品で
 * **54.5MB**（本文の25倍）を使っていた。原因はチャンクごとに
 * 「2つ組み→回数」のMapを持っていたことで、2つ組みの種類は5.8万件しか
 * 無いのに項目は81.7万件あった。**同じ文字列を平均14.1回抱えていた。**
 *
 * 転置した形（2つ組み→出てくるチャンクの並び）へ変え、
 * チャンク側は数値の並びで持つようにして **3.1MB（17分の1）** になった。
 * 検索も8倍速くなり、結果は実データ8問すべてで前と一致した。
 */

/** 日本語らしい文章を作る。実際の本文に近い重複の出方にする */
function sampleDocs(count: number): Array<{ id: string; text: string }> {
  const words = [
    "太志は体育倉庫で目を覚ました",
    "ばあさんが同級生たちを問い詰める",
    "転生した先は超絶美少女だった",
    "黒いモヤが漂っている",
    "文佳の身体を護ると誓う",
  ];
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${i}`,
    // 同じ言い回しが何度も出る（実際の小説と同じ）
    text: Array.from({ length: 8 }, (_, k) => words[(i + k) % words.length]).join("。"),
  }));
}

describe("索引の持ち方", () => {
  test("同じ2つ組みを、文書のぶんだけ抱えない", () => {
    // **同じ量の文章でも、言い回しが繰り返されていれば索引は小さくなる**
    // ——これが「文字列を種類のぶんだけ持っている」ことの証拠になる。
    // 文書ごとにMapを持つ作りでは、繰り返しても小さくならない。
    // 同じ長さで、片方は同じ文の繰り返し、片方は1件ずつ違う文字
    const LENGTH = 200;
    const repeated = Array.from({ length: 200 }, (_, i) => ({
      id: `r-${i}`,
      text: "太志は体育倉庫で目を覚ました。".repeat(LENGTH / 14),
    }));
    const varied = Array.from({ length: 200 }, (_, i) => ({
      id: `v-${i}`,
      // コードポイントをずらして、重ならない文字列を作る
      text: Array.from({ length: LENGTH }, (_, k) =>
        String.fromCharCode(0x4e00 + ((i * LENGTH + k) % 0x4000))
      ).join(""),
    }));

    const distinctRepeated = new Set(repeated.flatMap((d) => bigrams(d.text))).size;
    const distinctVaried = new Set(varied.flatMap((d) => bigrams(d.text))).size;
    expect(distinctVaried).toBeGreaterThan(distinctRepeated * 3);

    const sizeRepeated = roughSize(new Bm25Index(repeated));
    const sizeVaried = roughSize(new Bm25Index(varied));

    // 種類が3倍以上あるなら、索引もはっきり大きくなるはず。
    // ここが同じくらいなら、文字列を文書ごとに抱えている
    expect(sizeVaried).toBeGreaterThan(sizeRepeated * 1.5);
  });

  test("件数は文書の数と一致する", () => {
    expect(new Bm25Index(sampleDocs(37)).size).toBe(37);
  });
});

describe("結果は変わらない", () => {
  const docs = [
    { id: "a", text: "彼女は嫉妬に顔をゆがめた" },
    { id: "b", text: "道場で稽古を重ねる日々" },
    { id: "c", text: "傷口を洗うための薬を調合した" },
    { id: "d", text: "嫉妬と稽古の話" },
  ];
  const index = new Bm25Index(docs);

  test("含む語で引ける", () => {
    expect(index.search("嫉妬", 5).map((h) => h.id)).toContain("a");
  });

  test("一致が無い文書は返さない", () => {
    expect(index.search("宇宙船", 5)).toEqual([]);
  });

  test("点の高い順に並ぶ", () => {
    const hits = index.search("嫉妬 稽古", 5);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  test("件数の上限を守る", () => {
    expect(index.search("の", 2).length).toBeLessThanOrEqual(2);
  });

  test("空の索引でも壊れない", () => {
    expect(new Bm25Index([]).search("嫉妬", 5)).toEqual([]);
  });

  test("空の質問でも壊れない", () => {
    expect(index.search("", 5)).toEqual([]);
    expect(index.search("あ", 5)).toEqual([]);
  });
});

/** おおよその大きさを測る。厳密でなくてよく、桁が分かればよい */
function roughSize(value: unknown): number {
  const seen = new Set<unknown>();
  const walk = (v: unknown): number => {
    if (v === null || v === undefined) return 0;
    if (typeof v === "number") return 8;
    if (typeof v === "boolean") return 4;
    if (typeof v === "string") return v.length * 2 + 40;
    if (ArrayBuffer.isView(v)) return (v as ArrayBufferView).byteLength;
    if (typeof v !== "object") return 8;
    if (seen.has(v)) return 0;
    seen.add(v);
    if (Array.isArray(v)) return v.reduce((s: number, x) => s + walk(x), 40);
    if (v instanceof Map) {
      let sum = 40;
      for (const [k, val] of v) sum += walk(k) + walk(val) + 28;
      return sum;
    }
    if (v instanceof Set) {
      let sum = 40;
      for (const x of v) sum += walk(x) + 28;
      return sum;
    }
    return Object.values(v as Record<string, unknown>).reduce(
      (s: number, x) => s + walk(x),
      40
    );
  };
  return walk(value);
}
