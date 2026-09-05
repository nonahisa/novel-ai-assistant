import { describe, expect, it } from "vitest";
import {
  findMonotonousRuns,
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
function chunkOf(text: string, startLine = 0): Chunk {
  return {
    filePath: "C:/works/007.txt",
    index: 0,
    text,
    startLine,
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

/**
 * **連続の実体を取り出す**（作者の報告、2026-09-05）。
 *
 * 「よくわからなかった」の中身は3つだった。
 *
 * 1. 引用行がAIの選んだ1行で、**「た。」で終わらない台詞**のこともあった
 * 2. 文言は「5連続しています」のままAIの言い値だった
 * 3. 同じ連続にAIが3枚出せば、3枚並んだ
 *
 * どれも「4連続があるか」しか数えていなかったのが元である。
 * **どこの・どの語尾が・何文続いているか**まで数えれば、
 * 画面にはコードが確かめた事実だけを出せる。
 */
describe("連続の実体を取り出す", () => {
  it("4連続を1件返す（語尾・文数・行番号・書き出し）", () => {
    const runs = findMonotonousRuns(
      "彼は走った。\n彼は歩いた。\n彼は跳ねた。\n彼は笑った。",
      100
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].ending).toBe("た。");
    expect(runs[0].count).toBe(4);
    expect(runs[0].startLine).toBe(100);
    expect(runs[0].endLine).toBe(103);
    expect(runs[0].heads).toEqual([
      "彼は走った。",
      "彼は歩いた。",
      "彼は跳ねた。",
      "彼は笑った。",
    ]);
  });

  it("3連続は返さない（境は4文）", () => {
    expect(
      findMonotonousRuns("彼は走った。彼は歩いた。彼は跳ねた。彼は笑う。", 1)
    ).toEqual([]);
  });

  it("台詞を挟んでも連続は切れず、行番号もずれない", () => {
    // 台詞は数えないが、地の文のリズムは続いている。
    // **消して数えると行が詰まる**ので、台詞は空白へ置き換えて位置を保つ
    const runs = findMonotonousRuns(
      "彼は走った。\n彼は歩いた。\n「もう歩けない。休もう」\n彼は座った。\n彼は眠った。",
      1
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(4);
    expect(runs[0].startLine).toBe(1);
    // 台詞の1行を跨いだぶん、末尾は5行目になる
    expect(runs[0].endLine).toBe(5);
    expect(runs[0].heads).toEqual([
      "彼は走った。",
      "彼は歩いた。",
      "彼は座った。",
      "彼は眠った。",
    ]);
  });

  it("「た。」と「だ。」は別の語尾として数える", () => {
    expect(
      findMonotonousRuns("彼は走った。彼は歩いた。彼は喜んだ。彼は微笑んだ。", 1)
    ).toEqual([]);
  });

  it("2つの連続は別々に返す", () => {
    const runs = findMonotonousRuns(
      "彼は走った。\n彼は歩いた。\n彼は跳ねた。\n彼は笑った。\n" +
        "彼は喜んだ。\n彼は微笑んだ。\n彼は転んだ。\n彼は黙り込んだ。",
      1
    );

    expect(runs.map((run) => [run.ending, run.count, run.startLine, run.endLine])).toEqual([
      ["た。", 4, 1, 4],
      ["だ。", 4, 5, 8],
    ]);
  });

  it("複数行にまたがる文は、先頭の文が始まる行を返す", () => {
    const runs = findMonotonousRuns(
      "彼は走ったあと、\n深く息をついた。\n彼は歩いた。\n彼は跳ねた。\n彼は笑った。",
      10
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(4);
    // 1文目は10〜11行目にまたがる。錨は始まりの10行目
    expect(runs[0].startLine).toBe(10);
    expect(runs[0].endLine).toBe(14);
    // 書き出しは12字で切り、改行は畳む
    expect(runs[0].heads[0]).toBe("彼は走ったあと、深く息を…");
  });
});

/**
 * 指摘を、AIの錨からコードの数えた連続へ付け替える（作者の報告、2026-09-05）。
 *
 * **AIの出力は変えない。** 変えるのは作者へ見せるものだけで、
 * 引用行も文言も、コードが数えた実体に差し替える。
 */
describe("語尾単調の指摘を、連続へ付け替える", () => {
  /** 2107行目から始まる、台詞を1行挟んだ4連続 */
  const 連続 =
    "彼は走った。\n彼は歩いた。\n「もう歩けない」\n彼は座った。\n彼は眠った。";
  const 連続チャンク = chunkOf(連続, 2106);

  function 指摘(overrides: Record<string, unknown> = {}) {
    return {
      line: 2109,
      original: "「もう歩けない」",
      suggestion: "",
      reason: "語尾単調",
      explanation: "「〜た。」で終わる文が5連続しています",
      confidence: "high",
      ...overrides,
    };
  }

  it("台詞行に下ろされた錨も、連続の先頭行へ付け替える", () => {
    const { accepted, rejected } = validateProofreadIssues(
      { issues: [指摘()] },
      連続チャンク
    );

    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].line).toBe(2107);
    expect(accepted[0].original).toBe("彼は走った。");
    expect(accepted[0].target).toBe("彼は走った。");
  });

  it("説明文には、コードが数えた語尾・文数・行範囲が入る", () => {
    const { accepted } = validateProofreadIssues(
      { issues: [指摘()] },
      連続チャンク
    );

    // AIの言い値（5連続）ではなく、コードの数え値（4文）を出す
    expect(accepted[0].explanation).toBe(
      "「た。」で終わる地の文が4文続いています（2107〜2111行目）：" +
        "彼は走った。 ／ 彼は歩いた。 ／ …。直し方は作者が決めてください"
    );
  });

  it("同じ連続への3件は1件に畳み、畳んだぶんを内訳に残す", () => {
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          指摘(),
          指摘({ line: 2107, original: "彼は走った。" }),
          指摘({ line: 2111, original: "彼は眠った。" }),
        ],
      },
      連続チャンク
    );

    expect(accepted).toHaveLength(1);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "monotony_duplicate",
      "monotony_duplicate",
    ]);
  });

  it("AIの原文が本文に無く、行が範囲外でも、連続が実在すれば残す", () => {
    // **錨は最終的に捨てる値である。** 実在する連続の指摘を、AIが錨を
    // 言い間違えただけで落とすのは本末転倒（本体の判断、2026-09-05）
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          指摘({ line: 99999, original: "本文のどこにも無い一文である。" }),
        ],
      },
      連続チャンク
    );

    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].line).toBe(2107);
    expect(accepted[0].original).toBe("彼は走った。");
  });

  it("連続が無ければ、原文が本文に無くても not_monotonous で落ちる", () => {
    // 錨の照合を飛ばしても、**連続そのものの照合は飛ばさない**
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          指摘({ line: 99999, original: "本文のどこにも無い一文である。" }),
        ],
      },
      chunkOf("彼は走った。彼は歩いた。彼は跳ねた。彼は笑う。")
    );

    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toBe("not_monotonous");
  });

  it("別々の連続なら、それぞれ1件ずつ残す", () => {
    // 件数の上限は1000字あたり3件なので、2件を残すには本文の量が要る。
    // 埋め草は語尾を散らし、連続を作らないようにしてある
    const 埋め草 = "空は青い。風が吹く。雲が流れる。鳥が鳴いた。雨が降るだろう。\n";
    const 二連続 = chunkOf(
      "彼は走った。\n彼は歩いた。\n彼は跳ねた。\n彼は笑った。\n" +
        "彼は喜んだ。\n彼は微笑んだ。\n彼は転んだ。\n彼は黙り込んだ。\n" +
        埋め草.repeat(20),
      0
    );
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          指摘({ line: 2, original: "彼は歩いた。" }),
          指摘({ line: 7, original: "彼は転んだ。" }),
        ],
      },
      二連続
    );

    expect(rejected).toEqual([]);
    expect(accepted.map((issue) => issue.line)).toEqual([1, 5]);
  });
});
