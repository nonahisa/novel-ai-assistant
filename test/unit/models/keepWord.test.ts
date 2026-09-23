import { describe, expect, test } from "vitest";
import {
  emptyKeepWordSet,
  isKeptWord,
  MIN_KEEP_WORD_LENGTH,
  parseKeepWordSet,
  validateKeepWord,
  type KeepWord,
} from "../../src/models/keepWord";
import { validateTypoIssues } from "../../src/core/typoCheckValidation";
import { validateProofreadIssues } from "../../src/core/proofreadValidation";
import type { Chunk } from "../../src/core/chunker";

/**
 * 「直さない語」（設計書6.8.3）。
 *
 * **なぜ要るか。** 作者の10作品で誤字脱字を測ったところ（2026-08-17）、
 * 設定資料を抽出して固有名詞113語を渡してもなお、こう指摘してきた。
 *
 * - 「はよ」→「早く」
 * - 「急いどるんやろ？」→「急いでるんやろ？」
 * - 「なんゆうてまんのや？」→「なん言うてまんのや？」
 *
 * **方言は固有名詞ではない**ので、人物や場所をいくら抽出しても入ってこない。
 * プロンプトには「方言・訛りを検出しない」と書いてあるが守られない。
 */
function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/x/episode_0001.txt",
    text,
    startLine: 0,
    hash: "h",
  } as Chunk;
}

function keep(...words: string[]): KeepWord[] {
  return words.map((word) => ({ word, note: "", addedAt: "2026-08-17" }));
}

describe("守られているかの判定", () => {
  test("完全に一致すれば守る", () => {
    expect(isKeptWord("はよ", keep("はよ"))).toBe(true);
  });

  test("含んでいれば守る", () => {
    // **方言は活用する。** 「急いどる」を登録したら
    // 「急いどるんやろ？」も守られないと意味がない
    expect(isKeptWord("急いどるんやろ？", keep("急いどる"))).toBe(true);
    expect(isKeptWord("あらへんで", keep("あらへん"))).toBe(true);
  });

  test("関係の無い語は守らない", () => {
    expect(isKeptWord("溢れ出だした", keep("はよ", "あらへん"))).toBe(false);
  });

  test("1件も無ければ守らない", () => {
    expect(isKeptWord("はよ", [])).toBe(false);
  });

  test("空の指摘では判定しない", () => {
    expect(isKeptWord("", keep("はよ"))).toBe(false);
    expect(isKeptWord("   ", keep("はよ"))).toBe(false);
  });
});

describe("登録できる形か", () => {
  test("1文字は受け付けない", () => {
    // **「の」を登録すると本文のほとんどが守られる。**
    // 本物の誤字も出なくなり、作者は理由に気づけない
    expect(validateKeepWord("の")).toContain("短すぎます");
    expect(MIN_KEEP_WORD_LENGTH).toBe(2);
  });

  test("空は受け付けない", () => {
    expect(validateKeepWord("   ")).toContain("空です");
  });

  test("改行を含むものは受け付けない", () => {
    expect(validateKeepWord("はよ\n早く")).toContain("改行");
  });

  test("長すぎるものは受け付けない", () => {
    expect(validateKeepWord("あ".repeat(61))).toContain("長すぎます");
  });

  test("方言はそのまま通る", () => {
    expect(validateKeepWord("はよ")).toBeNull();
    expect(validateKeepWord("なんゆうてまんのや？")).toBeNull();
  });
});

describe("作者が手で書いたJSONを読む", () => {
  test("文字列だけの並びも読める", () => {
    // **作者が手で書くなら ["はよ", "せやな"] が自然である**
    const set = parseKeepWordSet({ words: ["はよ", "せやな"] });

    expect(set.words.map((entry) => entry.word)).toEqual(["はよ", "せやな"]);
  });

  test("項目の形でも読める", () => {
    const set = parseKeepWordSet({
      words: [{ word: "はよ", note: "関西弁", addedAt: "2026-08-17" }],
    });

    expect(set.words[0].note).toBe("関西弁");
  });

  test("同じ語は1つにまとめる", () => {
    expect(parseKeepWordSet({ words: ["はよ", "はよ"] }).words).toHaveLength(1);
  });

  test("壊れていたら例外を投げる", () => {
    // **空として扱って上書きすると、作者の登録がまるごと消える**
    expect(() => parseKeepWordSet("こわれています")).toThrow();
    expect(() => parseKeepWordSet({ words: "はよ" })).toThrow();
  });

  test("空の集合が作れる", () => {
    expect(emptyKeepWordSet().words).toEqual([]);
  });
});

describe("誤字脱字：守った語は指摘しない", () => {
  test.each([
    ["ワテにそんな丁寧な接客はいらへん。はよ仕事に戻り", "はよ", "早く", "はよ"],
    [
      "急いどるんやろ？　トゥエル坊の話を先に聞いたろか。",
      "急いどるんやろ？",
      "急いでるんやろ？",
      "急いどる",
    ],
    ["そんな時代やあらへんで", "あらへんで", "あらへん", "あらへん"],
  ])("弾く: %s", (text, target, suggestion, kept) => {
    const result = validateTypoIssues(
      {
        issues: [
          {
            line: 1,
            original: text,
            target,
            suggestion,
            reason: "誤変換",
            confidence: "medium",
          },
        ],
      },
      chunkOf(text),
      [],
      keep(kept)
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("kept_word");
  });

  test("守っていない語の本物の誤字は、今までどおり出る", () => {
    const text = "手足の冷たさがｈっきりとわかる。";
    const result = validateTypoIssues(
      {
        issues: [
          {
            line: 1,
            original: text,
            target: "ｈっきりと",
            suggestion: "はっきりと",
            reason: "誤変換",
            confidence: "high",
          },
        ],
      },
      chunkOf(text),
      [],
      keep("はよ", "あらへん")
    );

    expect(result.accepted).toHaveLength(1);
  });
});

describe("推敲：守った語を含む原文は、指摘ごと出さない", () => {
  // **推敲は原文まるごとを置き換える。**
  // 守る語が含まれていれば必ず巻き込むので、指摘そのものを出さない
  test("原文に含まれていれば弾く", () => {
    const line = "「はよ仕事に戻り。はよ戻り」";
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: line,
            suggestion: "",
            reason: "同語反復",
            explanation: "「はよ」が繰り返されています",
            confidence: "medium",
          },
        ],
      },
      chunkOf(line),
      keep("はよ")
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("kept_word");
  });

  test("守る語が無ければ、今までどおり判定する", () => {
    const original = "それは〆た後すぐに血抜き魔抜きをしなかったせいだ。";
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion: "それは〆た後すぐに血抜きや魔抜きをしなかったせいだ。",
            reason: "冗長",
            explanation: "「血抜き魔抜き」が続いています",
            confidence: "high",
          },
        ],
      },
      chunkOf(original),
      keep("はよ")
    );

    expect(result.accepted).toHaveLength(1);
  });
});
