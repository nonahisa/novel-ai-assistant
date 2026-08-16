import { describe, expect, test } from "vitest";
import {
  contradictionKey,
  parseContradictionResult,
  sortContradictions,
  validateContradictions,
  type AcceptedContradiction,
} from "../../src/core/contradictionValidation";
import type { Chunk } from "../../src/core/chunker";

/**
 * 矛盾検知の応答の検証（設計書6.10.1）。
 *
 * **AIの出力を信用しない。** とくに矛盾検知は、照らし合わせる材料
 * （設定資料・あらすじ）が多いほど、**材料側の文をそのまま引いて
 * 「本文にこうある」と言う**。
 */
const chunk: Chunk = {
  filePath: "C:/works/007.txt",
  index: 0,
  text: "月島灯は静かに頷いた。\n「わたくしが参りますわ」\n夜の図書塔は暗い。",
  startLine: 10,
  chapterStart: 7,
  chapterEnd: 7,
  hash: "abc123",
  segments: [],
} as unknown as Chunk;

function item(overrides: Record<string, unknown> = {}) {
  return {
    line: 12,
    excerpt: "「わたくしが参りますわ」",
    category: "人物",
    settingSays: "一人称は「僕」",
    textSays: "「わたくし」と言っている",
    note: "",
    severity: "medium",
    confidence: "high",
    ...overrides,
  };
}

describe("応答の読み取り", () => {
  test("コードフェンス付きでも読める", () => {
    const parsed = parseContradictionResult(
      '```json\n{"contradictions":[{"line":1}]}\n```'
    );

    expect(parsed?.contradictions).toHaveLength(1);
  });

  test("前置きが付いていても読める", () => {
    const parsed = parseContradictionResult(
      'はい、確認しました。\n{"contradictions":[]}'
    );

    expect(parsed?.contradictions).toEqual([]);
  });

  test("読めなければ null", () => {
    expect(parseContradictionResult("すみません、分かりません")).toBeNull();
  });
});

describe("受け入れる指摘", () => {
  test("本文に実在する引用は通す", () => {
    const result = validateContradictions(
      { contradictions: [item()] },
      chunk
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].filePath).toBe(chunk.filePath);
    expect(result.accepted[0].chunkHash).toBe(chunk.hash);
  });

  test("空白や記号の違いは吸収する", () => {
    // 引用のたびに全角空白が落ちる程度で捨てると、正しい指摘まで消える
    const result = validateContradictions(
      { contradictions: [item({ excerpt: "わたくしが参りますわ" })] },
      chunk
    );

    expect(result.accepted).toHaveLength(1);
  });
});

describe("弾く指摘", () => {
  test("本文に無い引用を弾く", () => {
    // 設定資料やあらすじの文をそのまま引いて「本文にこうある」と言う
    const result = validateContradictions(
      { contradictions: [item({ excerpt: "灯は銀髪であった" })] },
      chunk
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("excerpt_not_found");
  });

  test("チャンクの外の行を弾く", () => {
    const result = validateContradictions(
      { contradictions: [item({ line: 999 })] },
      chunk
    );

    expect(result.rejected[0].reason).toBe("line_out_of_range");
  });

  test("知らない分類を弾く", () => {
    // AIが勝手な分類名を作ると、タブ分けも絞り込みも壊れる
    const result = validateContradictions(
      { contradictions: [item({ category: "雰囲気" })] },
      chunk
    );

    expect(result.rejected[0].reason).toBe("unknown_category");
  });

  test("片方しか無い指摘を弾く", () => {
    // 「設定ではこう」だけでは、本文の何が問題なのか分からない
    const result = validateContradictions(
      { contradictions: [item({ textSays: "" })] },
      chunk
    );

    expect(result.rejected[0].reason).toBe("empty_comparison");
  });

  test("形が違うものを弾く", () => {
    const result = validateContradictions(
      { contradictions: ["矛盾しています", null, { line: 12 }] },
      chunk
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
  });

  test("応答そのものが空でも落ちない", () => {
    expect(validateContradictions(null, chunk).accepted).toEqual([]);
    expect(validateContradictions({}, chunk).accepted).toEqual([]);
  });
});

describe("確信度と重さ", () => {
  test("読めない値は low に寄せる", () => {
    // 強い指摘として扱わない
    const result = validateContradictions(
      { contradictions: [item({ confidence: "たぶん", severity: 3 })] },
      chunk
    );

    expect(result.accepted[0].confidence).toBe("low");
    expect(result.accepted[0].severity).toBe("low");
  });

  test("確信度の高いものを上に並べる", () => {
    // 下のほうは読まれない。迷っている指摘を上に置くと確かな指摘が埋もれる
    const make = (
      confidence: "high" | "medium" | "low",
      severity: "high" | "medium" | "low",
      line: number
    ) =>
      ({
        line,
        excerpt: "x",
        category: "人物",
        settingSays: "a",
        textSays: "b",
        note: "",
        severity,
        confidence,
        filePath: "C:/w/1.txt",
        chunkHash: "h",
      }) as AcceptedContradiction;

    const sorted = sortContradictions([
      make("low", "high", 1),
      make("high", "low", 2),
      make("high", "high", 3),
    ]);

    expect(sorted.map((entry) => entry.line)).toEqual([3, 2, 1]);
  });
});

describe("無視の記憶", () => {
  test("本文が変わったら別の指摘として扱う", () => {
    // 直したあとの本当の矛盾まで黙って捨てないため
    const base = {
      line: 12,
      excerpt: "「わたくしが参りますわ」",
      category: "人物",
      settingSays: "a",
      textSays: "b",
      note: "",
      severity: "medium",
      confidence: "high",
      filePath: "C:/w/1.txt",
      chunkHash: "before",
    } as AcceptedContradiction;

    expect(contradictionKey(base)).not.toBe(
      contradictionKey({ ...base, chunkHash: "after" })
    );
  });

  test("同じ指摘は同じ鍵になる", () => {
    const base = {
      line: 12,
      excerpt: "「わたくしが 参りますわ」",
      category: "人物",
      settingSays: "a",
      textSays: "b",
      note: "",
      severity: "medium",
      confidence: "high",
      filePath: "C:/w/1.txt",
      chunkHash: "h",
    } as AcceptedContradiction;

    // 引用の空白の揺れで別物にしない
    expect(contradictionKey(base)).toBe(
      contradictionKey({ ...base, excerpt: "「わたくしが参りますわ」" })
    );
  });
});
