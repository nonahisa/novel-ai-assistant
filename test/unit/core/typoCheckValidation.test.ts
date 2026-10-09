import { describe, expect, test } from "vitest";
import {
  checkParticleRange,
  parseTypoCheckResult,
  validateTypoIssues,
} from "../../../src/core/typoCheckValidation";
import type { Chunk } from "../../../src/core/chunker";

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

/*
 * ルビ・傍点の記法を壊す案を通さない（2026-10-08）。
 *
 * qwen3.5:9b が「｜霧鈴《きりすず》」の縦線だけを target にして
 * 「「',」へ置き換える案を返し、それが検算を通った
 * （docs/measurements/2026-10-05-typo-qwen3.5_9b.json の runs[0].raw）。
 * 作者が［当てる］を押すとルビが壊れる（実装ルール1）。
 */
describe("ルビ・傍点の記法を壊す案", () => {
  const RUBY_LINE =
    "　棚の上で、｜霧鈴《きりすず》が小さく鳴った。先代の観測員が作ったた道具である。";
  const EMPHASIS_LINE =
    "　書いてしまうと、《《ほんとう》》にあったことになる気がしたた。";

  function check(
    lineText: string,
    original: string,
    target: string,
    suggestion: string
  ) {
    const chunk = makeChunk(`一行目\n\n${lineText}`);
    return validateTypoIssues(
      {
        issues: [
          {
            line: 3,
            original,
            target,
            suggestion,
            reason: "誤変換",
            confidence: "high",
          },
        ],
      },
      chunk,
      []
    );
  }

  test("縦線だけを別の字へ替える案を落とす（測定で通っていた形）", () => {
    const result = check(
      RUBY_LINE,
      "棚の上で、｜霧鈴《きりすず》が小さく鳴った。",
      "｜",
      "「',"
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["notation_mark"]);
  });

  test("読み仮名の中身を直す案を落とす", () => {
    const result = check(RUBY_LINE, "｜霧鈴《きりすず》が", "きりすず", "きりすづ");
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["notation_mark"]);
  });

  test("二重山括弧ごと替える案を落とす", () => {
    const result = check(
      RUBY_LINE,
      "｜霧鈴《きりすず》が",
      "《きりすず》",
      "（きりすず）"
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["notation_mark"]);
  });

  test("ルビの親文字を直す案も落とす（記法の範囲に重なる）", () => {
    const result = check(RUBY_LINE, "｜霧鈴《きりすず》が", "霧鈴", "霧鐘");
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["notation_mark"]);
  });

  test("傍点の中身を直す案を落とす", () => {
    const result = check(
      EMPHASIS_LINE,
      "《《ほんとう》》にあった",
      "ほんとう",
      "本当"
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["notation_mark"]);
  });

  test("傍点の記号にまたがる案を落とす", () => {
    const result = check(
      EMPHASIS_LINE,
      "《《ほんとう》》にあった",
      "とう》》に",
      "とうに"
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["notation_mark"]);
  });

  test("記法を消す案を落とす", () => {
    const result = check(RUBY_LINE, "｜霧鈴《きりすず》が", "霧鈴《きりすず》", "霧鈴");
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["notation_mark"]);
  });

  test("記法の外の語に、ルビの記号を足す案を落とす", () => {
    const result = check(
      RUBY_LINE,
      "先代の観測員が",
      "観測員",
      "｜観測員《かんそくいん》"
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["notation_mark"]);
  });

  test("記法の外の語に、傍点の記号を足す案を落とす", () => {
    const result = check(RUBY_LINE, "先代の観測員が", "観測員", "《《観測員》》");
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["notation_mark"]);
  });

  test("同じ行の、記法の外の普通の誤字は通す", () => {
    const result = check(RUBY_LINE, "作ったた道具", "作ったた", "作った");
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("作った");

    const emphasis = check(EMPHASIS_LINE, "気がしたた。", "したた", "した");
    expect(emphasis.rejected).toEqual([]);
    expect(emphasis.accepted).toHaveLength(1);
  });

  test("ルビの親文字と同じ語でも、引用が記法の外なら通す", () => {
    // 同じ行に「霧鈴」が2つある。引用が指すのは記法の外のほう
    const line = "　｜霧鈴《きりすず》が鳴った。霧鈴がなる朝は寒い。";
    const result = check(line, "霧鈴がなる朝", "なる", "鳴る");
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });
});

/**
 * AIが申告した行番号を、original が実際にある行へ直す（設計書6.8.20、2026-10-10）。
 *
 * 矛盾検知（0.101.2）と同じ不具合が誤字脱字にもあった。original はチャンク全体で
 * 照らすので行がずれても通るが、助詞の範囲などの検査は**申告の行の文**で行うため、
 * 別の行の文で検査したうえ、ずれた行番号のまま画面へ出ていた。
 */
describe("申告の行を original のある行へ直す", () => {
  const issueAt = (line: number) => ({
    issues: [
      {
        line,
        original: "意外な行動",
        target: "意外",
        suggestion: "以外",
        reason: "誤変換",
        confidence: "high",
      },
    ],
  });

  test("申告の行に original が無ければ、original のある行へ直す", () => {
    // 11〜13行目。original は13行目にしか無い
    const chunk = makeChunk("雨が降っていた。\n風が強い。\n彼は意外な行動に出た。", 10);
    const result = validateTypoIssues(issueAt(11), chunk, []);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].line).toBe(13);
  });

  test("申告が正しければそのまま", () => {
    const chunk = makeChunk("雨が降っていた。\n風が強い。\n彼は意外な行動に出た。", 10);
    const result = validateTypoIssues(issueAt(13), chunk, []);
    expect(result.accepted[0].line).toBe(13);
  });

  test("同じ original が2か所にあれば、申告に近いほうへ直す", () => {
    // 11行目と15行目に同じ original がある
    const chunk = makeChunk(
      "彼は意外な行動に出た。\n雨。\n雨。\n雨。\n彼女は意外な行動に出た。",
      10
    );
    expect(validateTypoIssues(issueAt(14), chunk, []).accepted[0].line).toBe(15);
    expect(validateTypoIssues(issueAt(12), chunk, []).accepted[0].line).toBe(11);
  });

  test("ずれた行の文で助詞の範囲を検査しない（直したあとの行で検査する）", () => {
    // 本物の誤りは13行目「すでの僕」。AIは11行目と申告した。
    // 申告の行で検査すると original が見つからず範囲を伸ばせないまま通り、
    // 当てると「すでにの僕」になる。正しい行で検査すれば「すでの」へ伸びる
    const chunk = makeChunk(
      "彼はすでに僕を見ていた。\n雨が降っていた。\n彼はすでの僕を見ていた。",
      10
    );
    const raw = {
      issues: [
        {
          line: 11,
          original: "すでの僕",
          target: "すで",
          suggestion: "すでに",
          reason: "脱字",
          confidence: "high",
        },
      ],
    };
    const result = validateTypoIssues(raw, chunk, []);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ line: 13, target: "すでの" });
  });
});
