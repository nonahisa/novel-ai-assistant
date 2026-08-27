import { describe, expect, test } from "vitest";
import { buildKnownAtIndex, lookupKnownAt, lookupKnownAtValue,
  contradictionKey,
  deniesContradiction,
  lacksSetting,
  normalizeCategory,
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

/**
 * 実データ（いじめられっ子・gemma4:e4b）で実際に返ってきたものを固定する。
 *
 * **測る前は、どれも起きると思っていなかった。**
 */
describe("実データで見つかった、通してはいけない指摘", () => {
  test("選択肢をそのまま写した分類を受け取る", () => {
    // 3件すべてがこの形で返り、**正しい指摘を全部捨てていた**（見逃し0/3）
    for (const raw of ["人物|状態|時系列", "人物|外見", "人物：一人称、口調"]) {
      expect(normalizeCategory(raw), raw).toBe("人物");
    }
  });

  test("知らない語しか無ければ、やはり弾く", () => {
    expect(normalizeCategory("雰囲気")).toBeUndefined();
    expect(normalizeCategory("")).toBeUndefined();
  });

  test("「矛盾していません」と書いてある指摘を弾く", () => {
    // 配列があると、モデルは何かを埋めようとする
    const result = validateContradictions(
      {
        contradictions: [
          item({ note: "設定と本文は矛盾していません。" }),
        ],
      },
      chunk
    );

    expect(result.rejected[0].reason).toBe("self_denied");
  });

  test.each([
    "具体的な接触の可否に関する矛盾ではない。",
    "幽霊であるという設定と一致しています。",
    "設定と食い違いはありません。",
  ])("否定の言い回しを拾う: %s", (note) => {
    expect(deniesContradiction(note)).toBe(true);
  });

  test.each([
    "本文の描写（金髪）と設定（黒髪）が矛盾しています。",
    "設定と矛盾する可能性があります。",
    "意図的な変化の可能性があります。",
  ])("本当の指摘を否定と読み違えない: %s", (note) => {
    expect(deniesContradiction(note)).toBe(false);
  });

  test("設定の側が「設定が無い」と言っている指摘を弾く", () => {
    // 照らし合わせる相手が無いのだから、それは矛盾ではない
    const result = validateContradictions(
      { contradictions: [item({ settingSays: "設定情報なし" })] },
      chunk
    );

    expect(result.rejected[0].reason).toBe("no_setting");
  });

  test.each([
    "設定情報なし",
    "本文からは読み取れない。",
    "具体的な設定は見当たりません。",
    "年齢に関する記述はありません。",
  ])("設定が無いと言っている文を拾う: %s", (says) => {
    expect(lacksSetting(says)).toBe(true);
  });

  test.each(["一人称は「僕」", "黒髪の少年", "第1話で死亡し、幽霊になっている"])(
    "本当の設定を読み違えない: %s",
    (says) => {
      expect(lacksSetting(says)).toBe(false);
    }
  );

  test("設定と本文に同じことが書いてあれば弾く", () => {
    const result = validateContradictions(
      {
        contradictions: [
          item({ settingSays: "一人称は「僕」", textSays: "一人称は「僕」" }),
        ],
      },
      chunk
    );

    expect(result.rejected[0].reason).toBe("not_different");
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

/**
 * 「どの値が何話で分かるか」の索引（0.22.10で修正）。
 *
 * **再現**：以前は書く側が空白区切り、読む側がNUL区切りで鍵を別々に
 * 組み立てており、**読みは一度も当たらなかった**。裏取りプロンプトの
 * 「この設定が分かる話」は常に「（不明）」だった。読む側の区切りが
 * 生のNUL文字だったため、grepがファイルをバイナリ扱いして検索でも
 * 見つからなかった。鍵を1つの関数に集めて、ずれること自体を無くした。
 */
describe("どの値が何話で分かるか", () => {
  test("書いた値が、同じ項目と値で引ける", () => {
    const index = buildKnownAtIndex([
      {
        changes: [
          { field: "role", value: "課長", chapters: [7, 9] },
          { field: "appearance", value: "短髪", chapters: [3] },
        ],
      },
    ]);

    expect(lookupKnownAt(index, "role", "課長")).toEqual([7, 9]);
    expect(lookupKnownAt(index, "appearance", "短髪")).toEqual([3]);
  });

  test("値の前後の空白は無視する", () => {
    const index = buildKnownAtIndex([
      { changes: [{ field: "role", value: "課長", chapters: [7] }] },
    ]);

    expect(lookupKnownAt(index, "role", " 課長 ")).toEqual([7]);
  });

  test("空白を含む値でも、項目と値が混ざらない", () => {
    // 区切りが空白だと「role」＋「a b」と「role a」＋「b」が同じ鍵になる
    const index = buildKnownAtIndex([
      { changes: [{ field: "role", value: "b", chapters: [2] }] },
    ]);

    expect(lookupKnownAt(index, "role b", "")).toEqual([]);
  });

  test("話数の無い変化は索引に入れない", () => {
    const index = buildKnownAtIndex([
      { changes: [{ field: "role", value: "課長", chapters: [] }] },
    ]);

    expect(lookupKnownAt(index, "role", "課長")).toEqual([]);
  });
});

describe("値だけで索引を引く", () => {
  test("項目名が分からなくても、記録された話数が出る", () => {
    const index = buildKnownAtIndex([
      { changes: [{ field: "appearance", value: "短髪", chapters: [3] }] },
    ]);

    expect(lookupKnownAtValue(index, "短髪")).toEqual([3]);
    expect(lookupKnownAtValue(index, " 短髪 ")).toEqual([3]);
  });

  test("どの項目にも無い値は空", () => {
    const index = buildKnownAtIndex([
      { changes: [{ field: "role", value: "課長", chapters: [7] }] },
    ]);

    expect(lookupKnownAtValue(index, "部長")).toEqual([]);
  });
});
