import { describe, expect, test } from "vitest";
import {
  parseTypoCheckResult,
  validateTypoIssues,
} from "../../src/core/typoCheckValidation";
import type { Chunk } from "../../src/core/chunker";

function makeChunk(text: string, startLine = 0): Chunk {
  return {
    filePath: "C:\\work\\001.txt",
    index: 0,
    text,
    startLine,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "hash-1",
  };
}

describe("誤字脱字検知の応答解析", () => {
  test("生のJSONを解析できる", () => {
    const result = parseTypoCheckResult('{"issues": []}');
    expect(result).toEqual({ issues: [] });
  });

  test("コードフェンス付きでも解析できる", () => {
    const result = parseTypoCheckResult('```json\n{"issues": []}\n```');
    expect(result).toEqual({ issues: [] });
  });

  test("前後に説明文が付いていても波括弧部分だけ拾う", () => {
    const result = parseTypoCheckResult(
      '承知しました。\n{"issues": []}\n以上です。'
    );
    expect(result).toEqual({ issues: [] });
  });

  test("issuesが無ければ null", () => {
    expect(parseTypoCheckResult('{"foo": 1}')).toBeNull();
    expect(parseTypoCheckResult("not json")).toBeNull();
  });
});

describe("誤字脱字検知の検証", () => {
  test("本文中に実在する指摘は採用する", () => {
    // 1行目: "1: " が withLineNumbers による行番号prefix
    const chunk = makeChunk("1: 彼は意外な行動に出た。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "意外な行動",
          target: "意外",
          suggestion: "以外",
          reason: "誤変換",
          confidence: "high",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]).toMatchObject({
      target: "意外",
      suggestion: "以外",
      confidence: "high",
    });
  });

  test("originalが本文に実在しなければ幻覚として除外する", () => {
    const chunk = makeChunk("1: 彼は意外な行動に出た。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "存在しない引用文",
          target: "存在",
          suggestion: "そんざい",
          reason: "誤変換",
          confidence: "high",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("ungrounded");
  });

  test("targetがoriginalに含まれなければ除外する（適用位置が特定できない）", () => {
    const chunk = makeChunk("1: 彼は意外な行動に出た。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "意外な行動",
          // "target" が original に含まれない不整合な応答
          target: "別の語",
          suggestion: "以外",
          reason: "誤変換",
          confidence: "high",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("target_not_in_original");
  });

  test("固有名詞辞書に完全一致するtargetは除外する", () => {
    const chunk = makeChunk("1: ホンゴーは意外な行動に出た。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "ホンゴーは",
          target: "ホンゴー",
          suggestion: "ホンゴウ",
          reason: "誤変換",
          confidence: "medium",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, ["ホンゴー"]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("protected_term");
  });

  test("チャンクの行範囲外の行番号は除外する", () => {
    const chunk = makeChunk("1: 彼は意外な行動に出た。", 10);
    const raw = {
      issues: [
        {
          line: 999,
          original: "意外な行動",
          target: "意外",
          suggestion: "以外",
          reason: "誤変換",
          confidence: "high",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("out_of_range");
  });

  test("不正なconfidenceはlowに丸める", () => {
    const chunk = makeChunk("1: 彼は意外な行動に出た。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "意外な行動",
          target: "意外",
          suggestion: "以外",
          reason: "誤変換",
          confidence: "とても高い",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted[0].confidence).toBe("low");
  });

  test("issuesが配列でなければ invalid_shape", () => {
    const chunk = makeChunk("1: 本文");
    const result = validateTypoIssues({}, chunk, []);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("invalid_shape");
  });

  test("全角スペースのバイト表記の揺れを吸収して照合する", () => {
    // gemma系は全角スペースを <0xE3><0x80><0x80> のバイト表記のまま返すことがある
    const chunk = makeChunk("1: 彼は　意外な行動に出た。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "彼は<0xE3><0x80><0x80>意外な行動",
          target: "意外",
          suggestion: "以外",
          reason: "誤変換",
          confidence: "high",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted).toHaveLength(1);
  });
});
