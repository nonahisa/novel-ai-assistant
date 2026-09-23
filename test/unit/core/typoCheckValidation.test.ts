import { describe, expect, test } from "vitest";
import {
  checkParticleRange,
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

describe("助詞1文字ぶんの範囲ずれ", () => {
  test("誤った助詞を含めずに挿入で返してきたら、targetを1字伸ばす", () => {
    // 本文「すでの僕」（「すでに」の誤変換）に対し、AIは
    // target「すで」→ suggestion「すでに」と挿入で返してくる。
    // そのまま当てると「すでにの僕」になる
    const chunk = makeChunk("すでの僕の理性は限界だった。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "すでの僕の理性",
          target: "すで",
          suggestion: "すでに",
          reason: "脱字",
          confidence: "medium",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].target).toBe("すでの");
    expect(result.accepted[0].suggestion).toBe("すでに");
    expect(result.accepted[0].rangeExtended).toBe(true);
    expect(result.accepted[0].reason).toContain("範囲を1字広げました");
    // 確信度は変えない
    expect(result.accepted[0].confidence).toBe("medium");
  });

  test("直後が同じ助詞なら、当てても同じ字が続くだけなので弾く", () => {
    // 本文がすでに「すでに」なら、直す必要が無い
    const chunk = makeChunk("すでに僕の理性は限界だった。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "すでに僕の理性",
          target: "すで",
          suggestion: "すでに",
          reason: "脱字",
          confidence: "medium",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("no_change");
    // 弾いた記録には、AIが返した元の target を残す（照合に使うため）
    expect(result.rejected[0].target).toBe("すで");
  });

  test("targetが行末で、伸ばす先が無ければ従来どおり通す", () => {
    const chunk = makeChunk("彼はすで\n次の行");
    const raw = {
      issues: [
        {
          line: 1,
          original: "彼はすで",
          target: "すで",
          suggestion: "すでに",
          reason: "脱字",
          confidence: "low",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].target).toBe("すで");
    expect(result.accepted[0].rangeExtended).toBeUndefined();
    expect(result.accepted[0].reason).toBe("脱字");
  });

  test("余った1文字が助詞でなければ触らない", () => {
    const chunk = makeChunk("彼は意外に思った。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "彼は意外に思った",
          target: "意外",
          suggestion: "意外性",
          reason: "脱字",
          confidence: "high",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].target).toBe("意外");
    expect(result.accepted[0].rangeExtended).toBeUndefined();
  });

  test("suggestionがtargetで終わる型（前に助詞を足す）は扱わない", () => {
    // 本文「の僕」に target「僕」→ suggestion「の僕」。実測に例が無いため、
    // いまは伸ばさずそのまま通す（当てても壊れるのは同じだが、
    // 直し方が定まっていないので触らない）
    expect(checkParticleRange("それは僕の理性", "は僕の", "僕", "の僕")).toEqual(
      { kind: "keep" }
    );
  });

  test("抜粋がtargetのところで切れていたら、抜粋も1字伸ばす", () => {
    // AIの抜粋は対象のすぐ後ろで切れていることがある（`wouldDuplicateContext`
    // の注釈と同じ事情）。抜粋を伸ばさないと target が抜粋からはみ出し、
    // 適用側が位置を決められなくなる
    const chunk = makeChunk("彼はすでの僕を見ていた。");
    const raw = {
      issues: [
        {
          line: 1,
          original: "彼はすで",
          target: "すで",
          suggestion: "すでに",
          reason: "脱字",
          confidence: "high",
        },
      ],
    };

    const result = validateTypoIssues(raw, chunk, []);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].target).toBe("すでの");
    expect(result.accepted[0].original).toBe("彼はすでの");
    expect(result.accepted[0].rangeExtended).toBe(true);
  });

  test("抜粋の中にtargetが2度あっても、抜粋は伸ばさない", () => {
    // 「見ている場所」は最初の1つ。抜粋の終わりは別の場所なので、
    // 抜粋を伸ばすと本文に無い文字列を組み立ててしまう
    expect(
      checkParticleRange("すでのすでは僕", "すでのすで", "すで", "すでに")
    ).toEqual({ kind: "extend", target: "すでの", original: "すでのすで" });
  });

  test("行が取れないときは抜粋の範囲だけで見る", () => {
    // 行の外までは見に行かない（行末と同じ扱い）
    expect(checkParticleRange("すでの僕", "すでの僕", "すで", "すでに")).toEqual(
      { kind: "extend", target: "すでの", original: "すでの僕" }
    );
    expect(checkParticleRange("別の行", "すで", "すで", "すでに")).toEqual({
      kind: "keep",
    });
  });
});
