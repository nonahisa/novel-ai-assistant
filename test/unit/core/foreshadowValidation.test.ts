import { describe, expect, test } from "vitest";
import {
  locateQuoteInChunk,
  openForeshadowsFingerprint,
  parseForeshadowDetectResult,
  parseForeshadowResolveResult,
  validateForeshadowCandidates,
  validateForeshadowResolutions,
} from "../../../src/core/foreshadowValidation";
import type { Chunk } from "../../../src/core/chunker";
import { chunksOfEpisodeFile } from "../../../src/core/episodeChunks";

/**
 * 伏線の検知（P-25 / P-26）の検証（設計書6.35.2・6.35.3）。
 *
 * **AIの出力を信用しない。** ここで押さえるのは4つ。
 *   1. 引用が本文に**逐語で**在るか（言い換えは通さない）
 *   2. 指示の言葉が中身として返っていないか
 *   3. 既に台帳にあるものと重なっていないか（**まとめはコードで行う**）
 *   4. 回収の `id` が実在するか（一覧に無い番号で台帳を書き換えない）
 */

const BODY =
  "銀の懐中時計を、彼はしまい込んだ。\n" +
  "「これは、まだ話せない」\n" +
  "灯は黙って頷いた。";

const chunk: Chunk = {
  filePath: "C:/works/003.txt",
  index: 0,
  text: BODY,
  startLine: 0,
  chapterStart: 3,
  chapterEnd: 3,
  hash: "hash-003",
};

/** 2話ぶんをまとめたチャンク（引用がどちらの話に在るかを分ける） */
const merged: Chunk = {
  filePath: "C:/works/003.txt",
  index: 0,
  text: `${BODY}\n＝＝＝\n第5話の本文。錠前が静かに外れた。`,
  startLine: 0,
  chapterStart: 3,
  chapterEnd: 5,
  hash: "hash-merged",
  segments: [
    {
      filePath: "C:/works/003.txt",
      chapterStart: 3,
      chapterEnd: 3,
      start: 0,
      end: BODY.length,
      startLine: 0,
    },
    {
      filePath: "C:/works/005.txt",
      chapterStart: 5,
      chapterEnd: 5,
      start: BODY.length,
      end: BODY.length + 30,
      startLine: 0,
    },
  ],
};

/** 全話が1ファイルに入った形（合本）。区切り行は `collectedFile.test.ts` と同じ */
const COLLECTED_SAMPLE = [
  "【タイトル】",
  "見本の作品",
  "",
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１話　出会い",
  "",
  "【本文】",
  "",
  "　一話目の合言葉は青い封筒である。",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２話　再会",
  "",
  "【本文】",
  "",
  "　二話目の合言葉は赤い切符である。",
  "",
  "------------------------- エピソード3開始 -------------------------",
  "【エピソードタイトル】",
  "３話　別離",
  "",
  "【本文】",
  "",
  "　三話目の合言葉は銀の懐中時計である。",
  "",
].join("\r\n");

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    label: "銀の懐中時計",
    note: "まだ話せない事情があることを示している",
    quote: "銀の懐中時計を、彼はしまい込んだ",
    ...overrides,
  };
}

function detect(items: unknown[], known: Array<{ label: string; plantedQuote: string }> = [], target = chunk) {
  return validateForeshadowCandidates({ foreshadows: items }, target, known);
}

describe("応答の読み取り", () => {
  test("コードフェンス付きでも読める", () => {
    const parsed = parseForeshadowDetectResult(
      '```json\n{"foreshadows":[{"label":"鍵"}]}\n```'
    );

    expect(parsed?.foreshadows).toHaveLength(1);
  });

  test("前置きが付いていても読める", () => {
    const parsed = parseForeshadowResolveResult(
      'はい、確認しました。\n{"resolutions":[]}'
    );

    expect(parsed?.resolutions).toEqual([]);
  });

  test("読めなければ null", () => {
    expect(parseForeshadowDetectResult("見つかりませんでした")).toBeNull();
    expect(parseForeshadowResolveResult("{}")).toBeNull();
  });
});

describe("配置の候補（P-25）", () => {
  test("本文に逐語で在る引用は通す", () => {
    const result = detect([candidate()]);

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]).toMatchObject({
      label: "銀の懐中時計",
      quote: "銀の懐中時計を、彼はしまい込んだ",
      filePath: "C:/works/003.txt",
      chapter: 3,
      chunkHash: "hash-003",
    });
  });

  test("言い換えた引用は捨てる", () => {
    // **本文に無い箇所を「引用」してくる。** 実在しない引用では、
    // その候補が何を指しているのか作者に確かめようがない
    const result = detect([
      candidate({ quote: "彼は銀の時計をポケットへ入れた" }),
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("quote_not_found");
  });

  test("空白やバイト表記の揺れは吸収する", () => {
    // gemma系は全角スペースをバイト表記のまま返すことがある
    const result = detect([
      candidate({ quote: "銀の懐中時計を、<0xE3><0x80><0x80>彼はしまい込んだ" }),
    ]);

    expect(result.accepted).toHaveLength(1);
  });

  test("指示の言葉が返ってきたら弾く", () => {
    // 「該当なし」も、プロンプトの出力例に書いた言い換えも、中身ではない。
    // **引用は「本文に在るか」で落ちる**（指示語をなぞっただけの引用は、
    // 逐語照合を通らない）ので、理由が placeholder ではなく quote_not_found
    // になる。どちらにせよ、その候補は作者に見せない
    const result = detect([
      candidate({ label: "該当なし" }),
      candidate({ label: "一覧の見出しにする名前" }),
      candidate({ quote: "本文からそのまま写した引用" }),
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "placeholder",
      "placeholder",
      "quote_not_found",
    ]);
  });

  /**
   * ヒント語（「何を示唆しているか」など）は**日本語として自然な言い回し**
   * なので、本物の説明の中にも普通に現れる。部分一致で見ていたため、
   * 正当な示唆が空扱いになり、引用に指示語が混ざった候補が丸ごと捨てられた。
   */
  test("ヒント語を含むだけの説明は、空扱いにしない", () => {
    const result = detect([
      candidate({
        note: "この時計が何を示唆しているかは第3話ではまだ明かされない",
      }),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].note).toBe(
      "この時計が何を示唆しているかは第3話ではまだ明かされない"
    );
  });

  test("ヒント語そのもの（かっこ付きも）は、空扱いにする", () => {
    // 指示の言葉は、そのまま答えとして返ってくる
    const bare = detect([candidate({ note: "何を示唆しているか" })]);
    const bracketed = detect([candidate({ note: "（何を示唆しているか）" })]);

    expect(bare.accepted[0].note).toBe("");
    expect(bracketed.accepted[0].note).toBe("");
  });

  /**
   * **ヒント語が混ざっていても、本文に在る引用は採る。**
   * 落とすのは逐語照合の仕事であって、言葉の見た目ではない。
   */
  test("ヒント語を含む引用でも、本文に在れば採用する", () => {
    const result = detect([
      candidate({
        label: "銀の懐中時計",
        quote: "銀の懐中時計を、彼はしまい込んだ",
        note: "何を示唆しているかは、まだ書かれていない",
      }),
    ]);

    expect(result.accepted).toHaveLength(1);
  });

  test("示唆が中身の無い言葉なら、空にして候補は残す", () => {
    // 引用は実在するので、候補そのものは作者に見せる価値がある
    const result = detect([candidate({ note: "特になし" })]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].note).toBe("");
  });

  test("長すぎる名前は切り詰める（候補ごと捨てない）", () => {
    const result = detect([candidate({ label: "あ".repeat(30) })]);

    expect(result.accepted[0].label).toBe(`${"あ".repeat(15)}…`);
  });

  test("名前や引用が無ければ形が違う", () => {
    const result = detect([
      { note: "示唆だけ" },
      { label: "鍵", quote: 42 },
      "文字列",
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "shape",
      "shape",
      "shape",
    ]);
  });

  describe("既存の台帳との重なり", () => {
    test("同じ引用は出さない", () => {
      const result = detect(
        [candidate()],
        [{ label: "懐中時計のこと", plantedQuote: "銀の懐中時計を、彼はしまい込んだ" }]
      );

      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0].reason).toBe("duplicate");
    });

    test("同じ名前も出さない", () => {
      const result = detect(
        [candidate()],
        [{ label: "銀の懐中時計", plantedQuote: "別の箇所の引用" }]
      );

      expect(result.rejected[0].reason).toBe("duplicate");
    });

    test("同じ応答の中で二度出たら、2件目を落とす", () => {
      const result = detect([candidate(), candidate()]);

      expect(result.accepted).toHaveLength(1);
      expect(result.rejected[0].reason).toBe("duplicate");
    });
  });

  test("まとめたチャンクでは、引用が在る話の話数を付ける", () => {
    // チャンク全体の話数を付けると、第5話にしか無い記述が
    // 「第3話で張った」になる
    const result = detect(
      [candidate({ label: "外れた錠前", quote: "錠前が静かに外れた" })],
      [],
      merged
    );

    expect(result.accepted[0]).toMatchObject({
      filePath: "C:/works/005.txt",
      chapter: 5,
    });
  });
});

describe("回収の候補（P-26）", () => {
  function resolve(
    items: unknown[],
    open = [{ id: "foreshadow_001", plantedQuote: "動かない時計" }]
  ) {
    return validateForeshadowResolutions({ resolutions: items }, chunk, open);
  }

  test("一覧にある伏線で、引用が実在すれば通す", () => {
    const result = resolve([
      {
        id: "foreshadow_001",
        quote: "「これは、まだ話せない」",
        note: "話せない事情が明かされた",
      },
    ]);

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]).toMatchObject({
      id: "foreshadow_001",
      chapter: 3,
      filePath: "C:/works/003.txt",
    });
  });

  test("一覧に無い番号は捨てる", () => {
    // **番号を作ってくる。** 実在しない伏線を回収済みにはできない
    const result = resolve([
      { id: "foreshadow_999", quote: "「これは、まだ話せない」", note: "" },
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("unknown_id");
  });

  test("回収の根拠が本文に無ければ捨てる", () => {
    // 誤って回収済みの印が付くと、作者は安心して回収を忘れる
    const result = resolve([
      { id: "foreshadow_001", quote: "彼は時計の秘密を打ち明けた", note: "" },
    ]);

    expect(result.rejected[0].reason).toBe("quote_not_found");
  });

  test("張った箇所そのものを回収と言い張ったら弾く", () => {
    // 同じ話も回収検知の対象にしたので（0.24.10）、張った文が
    // 同じチャンクに居る。それを回収と誤認されると台帳が誤って閉じる
    const result = resolve(
      [
        {
          id: "foreshadow_001",
          quote: "「これは、まだ話せない」",
          note: "",
        },
      ],
      [{ id: "foreshadow_001", plantedQuote: "「これは、まだ話せない」" }]
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("planted_echo");
  });

  test("指示の言葉が返ってきたら弾く", () => {
    // **引用は「本文に在るか」で落とす。** 指示語をなぞっただけの引用は
    // 逐語照合を通らないので、理由は quote_not_found になる。
    // 見た目で弾かないのは、ヒント語（「どう回収されたか」など日本語として
    // 自然な句）を含む**本物の引用**まで捨ててしまうためである
    const result = resolve([
      { id: "foreshadow_001", quote: "回収している箇所の引用", note: "" },
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("quote_not_found");
  });

  test("ヒント語を含むだけの説明は、空扱いにしない", () => {
    const result = resolve([
      {
        id: "foreshadow_001",
        quote: "灯は黙って頷いた",
        note: "どう回収されたかは、この場面では言葉にされない",
      },
    ]);

    expect(result.accepted[0].note).toBe(
      "どう回収されたかは、この場面では言葉にされない"
    );
  });

  test("ヒント語そのものは、空扱いにする", () => {
    const result = resolve([
      { id: "foreshadow_001", quote: "灯は黙って頷いた", note: "どう回収されたか" },
    ]);

    expect(result.accepted[0].note).toBe("");
  });

  test("同じ伏線を二度回収したことにしない", () => {
    const result = resolve([
      { id: "foreshadow_001", quote: "「これは、まだ話せない」", note: "" },
      { id: "foreshadow_001", quote: "灯は黙って頷いた", note: "" },
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("duplicate");
  });
});

/**
 * 張った箇所の**近く**を回収と言い張る答え（実機確認 2026-09-25 深夜、
 * gemma4:e4b・ハイエルフ未亡人の写しの第8話）。
 *
 * 前は「引用が張った箇所と丸ごと同じ」ときだけ弾いていたので、
 * **張った台詞を含む1行まるごと**や、**張った台詞と同じ行の前半**を
 * 返されると、回収として通っていた（台帳が張った話のうちに閉じる）。
 *
 * 一方で、**同じ言い回しが本当に回収の場面で繰り返される**ことはある
 * （「あの時と同じ台詞を、今度は別の意味で言う」）。文字列だけで落とすと
 * それまで消えるので、**本文の中の位置**（行と話数）で見る。
 */
describe("張った箇所の近くを回収と言い張る（位置で見る）", () => {
  /** 第8話の本文から、張った2か所とその前後だけを抜いたもの（写しのまま） */
  const CH8_LINES = [
    "　門番に首から下げた冒険者証を見せながら聞くと、一瞥だけして顔をあげた。",
    "",
    "「帝都近郊でかなり強力な爆炎魔法が複数回観測されたんだ。魔物が騒いでいるので、スタンピードが起こるかもしれない」",
    "",
    "　心当たりがありすぎて、顔がひきつる。スタンピードは魔物が狂乱状態になって街を襲う現象のことだ。",
    "",
    "「ちょっと訳ありでね。こちらのエルシーさんを冒険者登録したいんだけど」",
    "",
    "　騒ぐ冒険者たちを放置して、エルシーさんを前に押し出す。ウィーネさんはエルシーさんの全身を見回し、ジト目でこちらを見た。",
    "",
    "「わかりました。エルシーさん、こちらへ」",
  ];
  const CH8 = CH8_LINES.join("\n");
  const ch8: Chunk = {
    filePath: "C:/works/8_金貨百枚分の小銭.txt",
    index: 0,
    text: CH8,
    startLine: 0,
    chapterStart: 8,
    chapterEnd: 8,
    hash: "hash-ch8",
  };

  /** 写しに置いた、答えの分かっている伏線（作者の記録の形） */
  const OPEN = [
    {
      id: "foreshadow_101",
      plantedQuote: "魔物が騒いでいるので、スタンピードが起こるかもしれない",
      plantedChapter: 8,
    },
    {
      id: "foreshadow_103",
      plantedQuote: "こちらのエルシーさんを冒険者登録したいんだけど",
      plantedChapter: 8,
    },
  ];

  test("張った台詞を含む1行まるごとは、回収ではない（e4b の実物の答え）", () => {
    const result = validateForeshadowResolutions(
      {
        resolutions: [
          {
            id: "foreshadow_103",
            quote: "「ちょっと訳ありでね。こちらのエルシーさんを冒険者登録したいんだけど」",
            note: "アジャーノが目立たないようにエルシーを冒険者登録させようとする行動が実際に起こり、登録室へ案内されたため、回収されたと言える。",
          },
        ],
      },
      ch8,
      OPEN
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("planted_echo");
  });

  test("張った台詞と同じ行の前半も、回収ではない（e4b の実物の答え）", () => {
    const result = validateForeshadowResolutions(
      {
        resolutions: [
          {
            id: "foreshadow_101",
            quote: "帝都近郊でかなり強力な爆炎魔法が複数回観測されたんだ。",
            note: "本文中でスタンピードの懸念が語られるのみで、実際にスタンピードが起こる描写や、その懸念が解消された描写はないため、回収されたとは言えない。",
          },
        ],
      },
      ch8,
      OPEN
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("planted_echo");
  });

  test("張った台詞の一部だけを返しても、同じ箇所なら回収ではない", () => {
    const result = validateForeshadowResolutions(
      {
        resolutions: [
          { id: "foreshadow_101", quote: "スタンピードが起こるかもしれない", note: "" },
        ],
      },
      ch8,
      OPEN
    );

    expect(result.rejected[0].reason).toBe("planted_echo");
  });

  test("同じ話でも、張った行とは別の行なら通す（同じ話の中での回収）", () => {
    // 短い話では同じ話の中で張って回収する（0.24.10）。行が違えば位置では落とさない
    const result = validateForeshadowResolutions(
      {
        resolutions: [
          { id: "foreshadow_103", quote: "「わかりました。エルシーさん、こちらへ」", note: "" },
        ],
      },
      ch8,
      OPEN
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]).toMatchObject({ id: "foreshadow_103", chapter: 8 });
  });

  test("張った言い回しが、あとの話でもう一度言われたら通す（その話数で）", () => {
    // 第8話と第10話をまとめたチャンク。**同じ台詞が2か所にある**。
    // 第8話の側は張った箇所、第10話の側は回収の場面での繰り返し
    const CH10 =
      "　試験官は目を丸くしたまま、書類に判を押した。\n" +
      "「こちらのエルシーさんを冒険者登録したいんだけど、って言われた時は冗談かと思いました。十分すぎる合格です」";
    const text = `${CH8}\n${CH10}`;
    const both: Chunk = {
      filePath: "C:/works/8_金貨百枚分の小銭.txt",
      index: 0,
      text,
      startLine: 0,
      chapterStart: 8,
      chapterEnd: 10,
      hash: "hash-ch8-10",
      segments: [
        {
          filePath: "C:/works/8_金貨百枚分の小銭.txt",
          chapterStart: 8,
          chapterEnd: 8,
          start: 0,
          end: CH8.length + 1,
          startLine: 0,
        },
        {
          filePath: "C:/works/10_槍が折れて、相棒ができた.txt",
          chapterStart: 10,
          chapterEnd: 10,
          start: CH8.length + 1,
          end: text.length,
          startLine: 0,
        },
      ],
    };

    const result = validateForeshadowResolutions(
      {
        resolutions: [
          {
            id: "foreshadow_103",
            quote: "こちらのエルシーさんを冒険者登録したいんだけど",
            note: "",
          },
        ],
      },
      both,
      OPEN
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]).toMatchObject({
      id: "foreshadow_103",
      chapter: 10,
      filePath: "C:/works/10_槍が折れて、相棒ができた.txt",
    });
  });

  test("張った話が入っていないチャンクなら、同じ言い回しでも通す", () => {
    // 第10話だけのチャンク。張った箇所はこのチャンクに居ないので、
    // 同じ言い回しは繰り返しである（張った箇所を指しようがない）
    const ch10: Chunk = {
      filePath: "C:/works/10_槍が折れて、相棒ができた.txt",
      index: 0,
      text: "「こちらのエルシーさんを冒険者登録したいんだけど、って言われた時は冗談かと思いました」",
      startLine: 0,
      chapterStart: 10,
      chapterEnd: 10,
      hash: "hash-ch10",
    };

    const result = validateForeshadowResolutions(
      {
        resolutions: [
          {
            id: "foreshadow_103",
            quote: "こちらのエルシーさんを冒険者登録したいんだけど",
            note: "",
          },
        ],
      },
      ch10,
      OPEN
    );

    expect(result.accepted[0]).toMatchObject({ id: "foreshadow_103", chapter: 10 });
  });

  test("張った話の中で、張った箇所より前の文は回収ではない（Kimi-K2.6 の実物の答え）", () => {
    /**
     * 教科書チート第5話の写し（2026-09-26 の測定）。奇病の伏線は
     * パッケの台詞（下の3行目）で張られる。**その前の行**を「奇病が実際に
     * 起きた」と回収に挙げてきた。張る前に回収はできない（張った話より前の
     * 話を対象から外しているのと同じ理由。設計書6.35.3）ので、同じ話の中でも
     * 張った箇所より前は回収として通さない。通すと台帳が第5話で閉じ、
     * 第15話の本当の回収（熱中症と分かる）が提案されなくなる
     */
    const CH5 = [
      "　背負われた男は、意識はあるようだが顔色が蒼白く、ぐったりしているようだ。",
      "",
      "「あれはおそらく、最近流行りの奇病でしょう。暑いところで仕事をすると、ああなる者が増えてきているようです」",
      "",
      "　なるほど。みんな同じ症状なんだとしたら、感染症か何かだろうか。",
    ].join("\n");
    const ch5: Chunk = {
      filePath: "C:/works/005.txt",
      index: 0,
      text: CH5,
      startLine: 0,
      chapterStart: 5,
      chapterEnd: 5,
      hash: "hash-ch5",
    };
    const open = [
      {
        id: "foreshadow_007",
        plantedQuote: "暑いところで仕事をすると、ああなる者が増えてきているようです",
        plantedChapter: 5,
      },
    ];

    const before = validateForeshadowResolutions(
      {
        resolutions: [
          {
            id: "foreshadow_007",
            quote: "背負われた男は、意識はあるようだが顔色が蒼白く、ぐったりしているようだ",
            note: "暑さで倒れる奇病が、治療院で実際に患者として持ち込まれた",
          },
        ],
      },
      ch5,
      open
    );
    expect(before.accepted).toEqual([]);
    expect(before.rejected[0].reason).toBe("before_planted");

    // 張った箇所より後の行は、これまでどおり同じ話の中の回収として通す
    const after = validateForeshadowResolutions(
      {
        resolutions: [
          { id: "foreshadow_007", quote: "みんな同じ症状なんだとしたら、感染症か何かだろうか", note: "" },
        ],
      },
      ch5,
      open
    );
    expect(after.rejected).toEqual([]);
    expect(after.accepted[0]).toMatchObject({ id: "foreshadow_007", chapter: 5 });
  });

  test("張った話数が分からない記録では、チャンクの中の張った文の位置をすべて張った箇所とみなす", () => {
    // 話数が無いと「どれが張った箇所か」を決められない。取り違えて
    // 台帳を閉じるより、回収を1回見送るほうが害が小さい
    const result = validateForeshadowResolutions(
      {
        resolutions: [
          {
            id: "foreshadow_103",
            quote: "「ちょっと訳ありでね。こちらのエルシーさんを冒険者登録したいんだけど」",
            note: "",
          },
        ],
      },
      ch8,
      [{ id: "foreshadow_103", plantedQuote: "こちらのエルシーさんを冒険者登録したいんだけど" }]
    );

    expect(result.rejected[0].reason).toBe("planted_echo");
  });
});

describe("引用の位置", () => {
  test("内訳をまたぐ引用は、話数を付けずに通す", () => {
    // チャンク全体には在るので捏造ではない。**推測で話数を埋めない**
    const at = locateQuoteInChunk(merged, "灯は黙って頷いた。\n＝＝＝\n第5話の本文");

    expect(at).toEqual({ filePath: "C:/works/003.txt", chapter: null });
  });

  test("どこにも無ければ undefined", () => {
    expect(locateQuoteInChunk(chunk, "存在しない一文")).toBeUndefined();
  });

  test("空の引用は通さない", () => {
    // 正規化で空になる引用は、どんな本文にも「含まれる」ことになってしまう
    expect(locateQuoteInChunk(chunk, "　 ")).toBeUndefined();
  });

  test("合本でも、3話目の引用は第3話になる", () => {
    // **合本を丸ごと切ると、全チャンクの話数が先頭の話数になる**
    // （作者の報告、2026-09-12「すべて1話と認識されている」）。
    // 話ごとに切る共通の口（`chunksOfEpisodeFile`）を通す
    const chunks = chunksOfEpisodeFile(
      "C:/works/all.txt",
      COLLECTED_SAMPLE,
      { chapterStart: 1, chapterEnd: 3 },
      { maxChars: 8000, mergeChars: 8000 }
    );

    expect(chunks).toHaveLength(1);
    expect(
      locateQuoteInChunk(chunks[0], "三話目の合言葉は銀の懐中時計である。")
    ).toEqual({ filePath: "C:/works/all.txt", chapter: 3 });
    expect(
      locateQuoteInChunk(chunks[0], "一話目の合言葉は青い封筒である。")
    ).toEqual({ filePath: "C:/works/all.txt", chapter: 1 });
  });
});

describe("未回収の集合の指紋", () => {
  const record = {
    id: "foreshadow_001",
    updatedAt: "2026-08-28T00:00:00.000Z",
    label: "銀の懐中時計",
    note: "",
    plantedQuote: "銀の懐中時計を、彼はしまい込んだ",
    plantedChapter: 3,
  };

  test("同じ集合なら同じ", () => {
    expect(openForeshadowsFingerprint([record])).toBe(
      openForeshadowsFingerprint([{ ...record }])
    );
  });

  test("1件増えれば変わる", () => {
    // **台帳が変われば判定も変わる。** 変わらないと、伏線を足したのに
    // 前回の結果が返り続ける
    expect(openForeshadowsFingerprint([record])).not.toBe(
      openForeshadowsFingerprint([record, { ...record, id: "foreshadow_002" }])
    );
  });

  test("更新時刻が変われば変わる", () => {
    expect(openForeshadowsFingerprint([record])).not.toBe(
      openForeshadowsFingerprint([
        { ...record, updatedAt: "2026-08-29T00:00:00.000Z" },
      ])
    );
  });

  test("時刻が同じでも、中身を手で直せば変わる", () => {
    // 作者がJSONを直接編集して時刻を書き換えなかった場合でも拾う
    expect(openForeshadowsFingerprint([record])).not.toBe(
      openForeshadowsFingerprint([{ ...record, note: "書き足した示唆" }])
    );
  });
});

describe("台詞の途中を括弧で包んだ引用（外側の括弧を外して照らす）", () => {
  /**
   * 教科書チート 第2話・第18話の写し（2026-09-26 の測定で gemma4:e4b が返した形）。
   * AIは台詞の途中だけを抜いて『』「」で包み直す。開き括弧の位置が本文と
   * 合わないので、書かれたままでは本文に無い——中身は逐語で在るのに落ちていた
   * （矛盾検知の `excerptInChunk` と同じ穴。設計書6.35.2）。
   */
  const TEXT =
    "『灯りであるか？　吾輩ならばその願いを叶えることができるのである。汝の願いはあと２つ残っているのであるが、汝は灯りを求めるか？』\n" +
    "\n" +
    "「やはり、灯りの神術ぐらいで枯渇するようなら、元々の霊力量はさほどではない可能性が高いな。イントは訓練が終わるまで、神術を使うのは禁止だ」";
  const bracketChunk: Chunk = {
    filePath: "C:/works/002.txt",
    index: 0,
    text: TEXT,
    startLine: 0,
    chapterStart: 2,
    chapterEnd: 2,
    hash: "hash-bracket",
  };

  test("配置：包み直した台詞は、括弧を外した中身が本文に在れば通す", () => {
    const result = validateForeshadowCandidates(
      {
        foreshadows: [
          {
            label: "願いの残り数と灯り",
            note: "願いが残り2つあることが示されている",
            quote: "『汝の願いはあと２つ残っているのであるが、汝は灯りを求めるか？』",
          },
        ],
      },
      bracketChunk
    );

    expect(result.rejected).toHaveLength(0);
    // 画面で本文の位置を探すのに使うので、**本文に在る形**で持つ
    expect(result.accepted[0].quote).toBe(
      "汝の願いはあと２つ残っているのであるが、汝は灯りを求めるか？"
    );
    expect(result.accepted[0].chapter).toBe(2);
  });

  test("回収：包み直した台詞も、括弧を外した中身が本文に在れば通す", () => {
    const result = validateForeshadowResolutions(
      {
        resolutions: [
          {
            id: "foreshadow_031",
            quote:
              "「灯りの神術ぐらいで枯渇するようなら、元々の霊力量はさほどではない可能性が高いな。」",
            note: "霊力量が多くないと明かされた",
          },
        ],
      },
      bracketChunk,
      [{ id: "foreshadow_031", plantedQuote: "願いはあと２つ", plantedChapter: 2 }]
    );

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].quote).toBe(
      "灯りの神術ぐらいで枯渇するようなら、元々の霊力量はさほどではない可能性が高いな。"
    );
  });

  test("外すのは外側の括弧だけ。中身を言い換えていれば落とす", () => {
    const result = validateForeshadowCandidates(
      {
        foreshadows: [
          {
            label: "天使の言葉",
            note: "特別な言葉がある",
            // 本文は「…残っているのであるが」。語尾を変えて包み直した形
            quote: "『汝の願いはあと２つ残っているのであるな』",
          },
        ],
      },
      bracketChunk
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("quote_not_found");
  });
});
