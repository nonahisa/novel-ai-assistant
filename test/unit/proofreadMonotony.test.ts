import { describe, expect, it } from "vitest";
import {
  hasMonotonousEnding,
  validateProofreadIssues,
} from "../../src/core/proofreadValidation";
import type { Chunk } from "../../src/core/chunker";

/**
 * 語尾単調の指摘を、コードで数え直す（作者の報告、2026-09-04）。
 *
 * 画面には「『〜た。』で終わる文が5連続です」と出ていたが、実際の文末は
 * 「いる。／いた。／だろう。／ないわ」／だ。」で、**どこにも5連続は無かった。**
 * AIは数を数えられないので、**言い値をそのまま作者へ届けない。**
 * 他の観点で「本文に実在するか」を照合しているのと同じ思想で、
 * 4連続が本当にあるかだけをコードで確かめ、無ければ指摘ごと捨てる。
 */
function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/007.txt",
    index: 0,
    text,
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "abc123",
    segments: [],
  } as unknown as Chunk;
}

function verdictOf(text: string, original: string) {
  return validateProofreadIssues(
    {
      issues: [
        {
          line: 1,
          original,
          suggestion: "",
          reason: "語尾単調",
          explanation: "「〜た。」で終わる文が5連続です",
          confidence: "high",
        },
      ],
    },
    chunkOf(text)
  );
}

/** 作者の報告に出てきた本文そのもの（2026-09-04） */
const 作者の実例 =
  "幼馴染みの王女殿下から手渡された細長い袋は、ズッシリと重かった。" +
  "その時点で嫌な予感がしていたのだが、開けてみると見覚えがある国宝の宝剣である。" +
  "鍔に施された赤い魔石は、異様に細かい三次元魔方陣の影響で、" +
  "角度を少し変えるだけで暴れるように輝いている。" +
  "鞘にもルーペでも持ってこないとわからないような、" +
  "複雑な幾何学模様が銀色に反射していた。間違いなく国内最強の剣だろう。" +
  "「勘違いしないでよね。その剣はあげるんじゃないわ」" +
  "ならば貸すということだろうか。どちらにせよ同じことだ。";

describe("語尾単調を数え直す", () => {
  it("作者の実例（並んでいない）は、指摘ごと捨てる", () => {
    // 文末は た。／る。／る。／た。／う。／か。／だ。——4連続はどこにも無い
    const result = verdictOf(
      作者の実例,
      "幼馴染みの王女殿下から手渡された細長い袋は、ズッシリと重かった。"
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("not_monotonous");
  });

  it("本当に4連続なら残す", () => {
    const text = "彼は走った。彼は歩いた。彼は跳ねた。彼は笑った。";
    const result = verdictOf(text, "彼は走った。彼は歩いた。");

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  it("3連続では捨てる（境は4文）", () => {
    const text = "彼は走った。彼は歩いた。彼は跳ねた。彼は笑う。";
    const result = verdictOf(text, "彼は走った。彼は歩いた。");

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("not_monotonous");
  });

  it("「た。」と「だ。」が混ざった4連続は捨てる", () => {
    // 濁点で意味が違う。「〜た」と「〜だ」を同じ語尾と数えると、
    // 今回のような数え違いを素通りさせる
    const text = "彼は走った。彼は歩いた。彼は喜んだ。彼は微笑んだ。";
    const result = verdictOf(text, "彼は走った。彼は歩いた。");

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("not_monotonous");
  });

  it("台詞を挟んだ地の文の4連続は残す", () => {
    // 台詞は地の文のリズムを切らない（台詞そのものは数えない）
    const text =
      "彼は走った。彼は歩いた。「もう歩けない。休もう」彼は座った。彼は眠った。";
    const result = verdictOf(text, "彼は走った。彼は歩いた。");

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  it("会話文だけの4連続は、語尾単調の指摘にしない", () => {
    // 台詞の語尾は人物の話し方であって、地の文の単調さとは別物である
    const text = "「行った。」「来た。」「見た。」「寝た。」";
    const result = verdictOf(text, text);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("not_monotonous");
  });
});

describe("語尾の数え方そのもの", () => {
  it.each([
    ["彼は走った。彼は歩いた。彼は跳ねた。彼は笑った。", true],
    ["彼は走った。彼は歩いた。彼は跳ねた。", false],
    // 改行を挟んでも、地の文の並びは続いている
    ["彼は走った。\n彼は歩いた。\n彼は跳ねた。\n彼は笑った。", true],
    // 感嘆符・疑問符は句点と別の語尾として数える
    ["彼は走った！彼は歩いた！彼は跳ねた！彼は笑った！", true],
    ["彼は走った。彼は歩いた。彼は跳ねた！彼は笑った。", false],
    [作者の実例, false],
  ])("%s → %s", (text, expected) => {
    expect(hasMonotonousEnding(text)).toBe(expected);
  });
});
