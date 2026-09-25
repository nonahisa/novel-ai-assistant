import { describe, expect, test } from "vitest";
import {
  validateTypoIssues,
  type AcceptedTypoIssue,
} from "../../../src/core/typoCheckValidation";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 誤字脱字検知を、正解つきの台で測って見つかった検算の穴（2026-09-25〜26）。
 *
 * 題材は教科書チートの先頭10話。正解（確実21件）と、手元7モデル・さくら10モデル・
 * Claude の答えを突き合わせたところ、**検算が正しい指摘を捨てていた**。
 *
 * 1. 文中に紛れた全角空白（「、　」→「、」）を必ず捨てていた。答えの読み取りで
 *    前後の空白を削り、比べるときも空白を消していたため、「直しにならない」扱いになる
 * 2. さくらの gemma-4-31B-it は、修正案に前後の句を入れてくる
 *    （「身体をの」→「身体の緊張を無理やり」）。正しく見つけた9件が
 *    「文の書き換え」「当てると本文が二重になる」として捨てられていた
 * 3. プロンプトは「明らかな入力ミス」も拾えと言うのに、地の文の行末の句点抜けを
 *    「末尾の句読点だけ」として捨てていた（台詞の末尾と区別していなかった）
 *
 * **本文を守る決まりは崩さない。** 当てた結果を、適用処理（`proposalPanel.ts` の
 * `applyIssue`）と同じ手順で組み立てて確かめる。
 */

function lineChunk(text: string): Chunk {
  return {
    filePath: "本文/episode_0002.txt",
    index: 0,
    text,
    startLine: 0,
    chapterStart: 2,
    chapterEnd: 2,
    hash: "h",
  };
}

function judge(
  line: string,
  issue: { original: string; target: string; suggestion: string }
) {
  return validateTypoIssues(
    { issues: [{ line: 1, reason: "衍字", confidence: "high", ...issue }] },
    lineChunk(line),
    [],
    []
  );
}

/** 適用処理と同じ手順で当てる（抜粋で位置を決め、対象だけを置き換える） */
function applyTo(line: string, issue: AcceptedTypoIssue): string {
  const at = line.indexOf(issue.original) + issue.original.indexOf(issue.target);
  return (
    line.slice(0, at) + issue.suggestion + line.slice(at + issue.target.length)
  );
}

describe("文中に紛れた全角空白を取る直し", () => {
  const line = "額に縦に２本並んだ角が、　パチパチとスタンガンのような音を立てている。";

  test("「、　」→「、」を通し、当てると空白だけが消える", () => {
    const result = judge(line, {
      original: "角が、　パチパチと",
      target: "、　",
      suggestion: "、",
    });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    // 答えの読み取りで全角空白を削らない（削ると「、」→「、」になる）
    expect(result.accepted[0].target).toBe("、　");
    expect(applyTo(line, result.accepted[0])).toBe(
      "額に縦に２本並んだ角が、パチパチとスタンガンのような音を立てている。"
    );
  });

  test("全角空白をバイトの札で書いてきても、空白の直しとして読む", () => {
    // gemma4:e4b が実際に返した形（全角空白 U+3000 の UTF-8 を札で書いた）
    const space = "<0xE3><0x80><0x80>";
    const result = judge(line, {
      original: `角が、${space}パチパチと`,
      target: `角が、${space}パチパチと`,
      suggestion: "角が、パチパチと",
    });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(applyTo(line, result.accepted[0])).toBe(
      "額に縦に２本並んだ角が、パチパチとスタンガンのような音を立てている。"
    );
  });

  test("字として読めない札は戻さず、空白の直しとしても読まない", () => {
    const result = judge(line, {
      original: "角が、<0xE3><0x80>パチパチと",
      target: "角が、<0xE3><0x80>パチパチと",
      suggestion: "角が、パチパチと",
    });
    expect(result.accepted).toHaveLength(0);
  });

  test("感嘆符・疑問符のあとの全角空白は作法なので取らない", () => {
    const text = "すごい！　本当にできたんだ。";
    const result = judge(text, {
      original: "すごい！　本当に",
      target: "！　",
      suggestion: "！",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("whitespace_only");
  });

  test("行頭の字下げは取らない", () => {
    const text = "　そう自分に言い聞かせた。";
    const result = judge(text, {
      original: "　そう自分に",
      target: "　そう",
      suggestion: "そう",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("whitespace_only");
  });

  test("英字の間の空白は取らない", () => {
    const text = "画面に Hello World と出た。";
    const result = judge(text, {
      original: "Hello World",
      target: "o W",
      suggestion: "oW",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("whitespace_only");
  });

  test("空白の向きが逆（足す直し）は通さない", () => {
    const text = "角が、パチパチと音を立てる。";
    const result = judge(text, {
      original: "角が、パチパチと",
      target: "、",
      suggestion: "、　",
    });
    expect(result.accepted).toHaveLength(0);
  });
});

describe("修正案に前後の句を入れてくる答え（さくら gemma-4-31B-it）", () => {
  /** 実際に返ってきた答え。正しく見つけていたのに、検算がすべて捨てていた */
  const cases: Array<{
    name: string;
    line: string;
    original: string;
    target: string;
    suggestion: string;
    fixed: string;
  }> = [
    {
      name: "第2話14行 衍字（後ろの句を抱えている）",
      line: "そう自分に言い聞かせて、身体をの緊張を無理やり解いていく。",
      original: "言い聞かせて、身体をの緊張を無理やり",
      target: "身体をの",
      suggestion: "身体の緊張を無理やり",
      fixed: "そう自分に言い聞かせて、身体の緊張を無理やり解いていく。",
    },
    {
      name: "第2話101行 衍字（前後の句を抱えている）",
      line: "自分の力より重いものを動かす方法として、教科書に載っていたのを原理を思い出す。",
      original: "教科書に載っていたのを原理を思い出す",
      target: "のを原理",
      suggestion: "教科書に載っていた原理を思い出す",
      fixed: "自分の力より重いものを動かす方法として、教科書に載っていた原理を思い出す。",
    },
    {
      name: "第2話152行 誤字（前の句を抱えている）",
      line: "リナの手を拾い、散らばる折れた幌の骨組みの中から、手頃な棒を拾って構える。",
      original: "リナの手を拾い、散らばる折れた幌の",
      target: "拾い",
      suggestion: "リナの手を離し",
      fixed: "リナの手を離し、散らばる折れた幌の骨組みの中から、手頃な棒を拾って構える。",
    },
    {
      name: "第4話39行 衍字（前の句と句点を抱えている）",
      line: "下級貴族の嫡男で、今は８歳にである。",
      original: "今は８歳にである。",
      target: "にである",
      suggestion: "今は８歳である。",
      fixed: "下級貴族の嫡男で、今は８歳である。",
    },
    {
      name: "第5話109行 脱字",
      line: "「どうか安心してくだい」",
      original: "どうか安心してくだい",
      target: "くだい",
      suggestion: "安心してください",
      fixed: "「どうか安心してください」",
    },
    {
      name: "第5話141行 衍字",
      line: "感心した風に院長のが言ってくるが、ちょっとイラッとする。",
      original: "感心した風に院長のが言ってくるが",
      target: "のが",
      suggestion: "感心した風に院長が言ってくるが",
      fixed: "感心した風に院長が言ってくるが、ちょっとイラッとする。",
    },
    {
      name: "第6話29行 脱字",
      line: "前世の記憶の事は何と説明して良いわからないので、省略している。",
      original: "何と説明して良いわからないので",
      target: "良いわからない",
      suggestion: "何と説明して良いかわからないので",
      fixed: "前世の記憶の事は何と説明して良いかわからないので、省略している。",
    },
    {
      name: "第6話32行 誤字（後ろの句と読点を抱えている）",
      line: "急に吐き気や頭痛、倦怠感の襲われて、場合によっては死んでしまう",
      original: "倦怠感の襲われて、",
      target: "倦怠感の",
      suggestion: "倦怠感に襲われて、",
      fixed: "急に吐き気や頭痛、倦怠感に襲われて、場合によっては死んでしまう",
    },
    {
      name: "第8話81行 衍字（3字消す）",
      line: "護衛を引き受けていただいただけるだけで十分ですわ」",
      original: "引き受けていただいただけるだけで十分ですわ",
      target: "いただいただける",
      suggestion: "引き受けていただけるだけで十分ですわ",
      fixed: "護衛を引き受けていただけるだけで十分ですわ」",
    },
  ];

  test.each(cases)("$name", ({ line, original, target, suggestion, fixed }) => {
    const result = judge(line, { original, target, suggestion });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(applyTo(line, result.accepted[0])).toBe(fixed);
    // **AIの言い分をそのまま採らなかったことを、作者に見せる**
    expect(result.accepted[0].reason).toContain("修正案から前後の文を外しました");
  });

  test("句点1字を抱えた答えでも、句点が二重にならない", () => {
    // 手元で「行う。。」になる答えが通っていた（Qwen3.6-35B-A3B）
    const line = "必要に応じて気道確保と人工呼吸を行うっと。";
    const result = judge(line, {
      original: "人工呼吸を行うっと。",
      target: "行うっと",
      suggestion: "行う。",
    });
    expect(result.accepted).toHaveLength(1);
    expect(applyTo(line, result.accepted[0])).toBe(
      "必要に応じて気道確保と人工呼吸を行う。"
    );
  });

  test("抱えた句を外すと、字の直しでなく言い換えになるものは捨てる", () => {
    // 実際に原稿を壊しかけた答え（設計書6.8.11）。外しても「会わす→会わせる」
    // 「ぐらい→くらい」の言い換えで、誤字脱字の直しの形をしていない
    const line = "「あんたが望むなら、夢で会わすぐらいのことはできるんだがね」";
    const result = judge(line, {
      original: line,
      target: "会わすぐらい",
      suggestion: "夢で会わせるくらいのことはできるんだがね",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("duplicates_context");
  });

  test("抱えた句が本文と合わなければ、これまでどおり捨てる", () => {
    const line = "あんた力込めすぎだよ⁉　いったん止まりな！";
    const result = judge(line, {
      original: "あんた力込めすぎだよ",
      target: "あんた力込めすぎだよ",
      suggestion: "あんたは力を込めすぎだよ⁉　いったん止めな！",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("rewrites_span");
  });
});

describe("当てると本文が壊れる修正案（誤検出の確かめで見つかった、2026-09-26）", () => {
  test("足す字が、本文ですぐ後ろにもうある（「痛」→「痛い」で「痛いい」）", () => {
    // さくら gpt-oss-120b が実際に返した。本文はすでに「痛い」
    const line = "こんな簡単なことで無駄遣いしてしまったのは痛い。";
    const result = judge(line, {
      original: "無駄遣いしてしまったのは痛",
      target: "痛",
      suggestion: "痛い",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("no_change");
  });

  test("足す字が、本文ですぐ前にもうある", () => {
    const line = "今日はとても寒い。";
    const result = judge(line, {
      original: "とても寒い",
      target: "も寒い",
      suggestion: "ても寒い",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("no_change");
  });

  test("閉じ括弧を句点に替える（台詞の括弧が消える）", () => {
    // gemma4:e4b が実際に返した
    const line = "「石鹸とグリセリンを作る、だそうです」";
    const result = judge(line, {
      original: "石鹸とグリセリンを作る、だそうです」",
      target: "石鹸とグリセリンを作る、だそうです」",
      suggestion: "石鹸とグリセリンを作る、だそうです。",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("bracket_removed");
  });

  test("閉じ忘れの括弧を足す直しは通す", () => {
    const line = "「わかった。すぐ行くよ";
    const result = judge(line, {
      original: "すぐ行くよ",
      target: "行くよ",
      suggestion: "行くよ」",
    });
    expect(result.accepted).toHaveLength(1);
  });
});

describe("行末の句点抜け", () => {
  test("地の文の行末に句点を足す直しは通す", () => {
    const line = "父上が軍隊にいた頃の部下がそのまま移住してきたそうだ";
    const result = judge(line, {
      original: "そのまま移住してきたそうだ",
      target: "きたそうだ",
      suggestion: "きたそうだ。",
    });
    expect(result.accepted).toHaveLength(1);
    expect(applyTo(line, result.accepted[0])).toBe(`${line}。`);
  });

  test("台詞の末尾には足さない（閉じ括弧の前）", () => {
    const result = judge("「ナイン様が会頭だ」", {
      original: "ナイン様が会頭だ",
      target: "会頭だ",
      suggestion: "会頭だ。",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("punctuation_only");
  });

  test("閉じていない台詞の行末にも足さない", () => {
    const result = judge("「長い話になるけれど、聞いてくれるかな", {
      original: "聞いてくれるかな",
      target: "くれるかな",
      suggestion: "くれるかな。",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("punctuation_only");
  });

  test("行の途中の句点は足さない", () => {
    const result = judge("移住してきたそうだ　そして村ができた。", {
      original: "移住してきたそうだ",
      target: "きたそうだ",
      suggestion: "きたそうだ。",
    });
    expect(result.accepted).toHaveLength(0);
  });

  test("記号で終わる行には足さない", () => {
    const result = judge("そして……", {
      original: "そして……",
      target: "……",
      suggestion: "……。",
    });
    expect(result.accepted).toHaveLength(0);
  });

  test("句点を取る直しは、これまでどおり捨てる", () => {
    const result = judge("移住してきたそうだ。", {
      original: "移住してきたそうだ。",
      target: "そうだ。",
      suggestion: "そうだ",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("punctuation_only");
  });
});
