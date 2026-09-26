import { describe, expect, test } from "vitest";
import {
  explainProofreadReason,
  hasLongSentence,
  hasRepetition,
  isDialogueOnly,
  mentionsForbiddenAspect,
  normalizeReason,
  paraphrasesInsteadOfOpening,
  parseProofreadResult,
  sortProofreadIssues,
  validateProofreadIssues,
  type AcceptedProofreadIssue,
} from "../../../src/core/proofreadValidation";
import {
  issueBudget,
  MAX_ISSUES_PER_1000_CHARS,
  PROOFREAD_REASONS,
} from "../../../src/prompts/proofread";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 推敲の提案の検証（設計書6.9.1）。
 *
 * **いちばん危ないのは出しすぎること。** 誤字脱字には正解があるが、
 * 推敲には無い。AIはどの文にも何かしら言えるので、放っておくと
 * 全部の文に提案が付き、作者は読むだけで疲れて機能ごと使わなくなる。
 */
function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/007.txt",
    index: 0,
    text,
    startLine: 10,
    chapterStart: 7,
    chapterEnd: 7,
    hash: "abc123",
    segments: [],
  } as unknown as Chunk;
}

const chunk = chunkOf(
  "まず最初に、彼は立ち上がった。\n彼は歩いた。彼は走った。彼は止まった。\n夜が明けた。"
);

function item(overrides: Record<string, unknown> = {}) {
  return {
    line: 11,
    original: "まず最初に",
    suggestion: "まず",
    reason: "冗長",
    explanation: "同じ意味が重なっています",
    confidence: "high",
    ...overrides,
  };
}

describe("応答の読み取り", () => {
  test("コードフェンス付きでも読める", () => {
    expect(
      parseProofreadResult('```json\n{"issues":[{"line":1}]}\n```')?.issues
    ).toHaveLength(1);
  });

  test("読めなければ null", () => {
    expect(parseProofreadResult("特にありません")).toBeNull();
  });
});

describe("受け入れる提案", () => {
  test("本文に実在する原文は通す", () => {
    const result = validateProofreadIssues({ issues: [item()] }, chunk);

    expect(result.accepted).toHaveLength(1);
    // 推敲は原文まるごとを置き換える
    expect(result.accepted[0].target).toBe("まず最初に");
  });
});

/**
 * 1.5で足した2観点（設計書6.30）。
 *
 * 作者の創作論（読みやすさの技術）から起こしたもので、**先の4つのように
 * 実データの失敗から削り出した観点ではない。実モデルでの見逃し・誤検出は
 * まだ測っていない。** ここで確かめているのは「検証を素通りしないか」だけで、
 * AIがこの2つをどれだけ拾えるかは分かっていない。
 */
describe("漢字ひらき・語尾単調（1.5で追加）", () => {
  const kanji = chunkOf("所謂、彼は殆ど何も言わなかった。");

  test("漢字ひらきは、ひらがなの修正案ごと通る", () => {
    // 機械的に直せるので、修正案を書かせている
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "所謂",
            suggestion: "いわゆる",
            reason: "漢字ひらき",
            explanation: "「所謂（いわゆる）」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      kanji
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("いわゆる");
  });

  /*
    **漢字ひらきで修正案が空でも、落とさない**（作者の裁定、2026-09-12）。

    一度「修正案が空で、常用漢字表に無い字も無いなら落とす」を入れたが取り下げた。
    作者の指摘「『然し』はひらいたほうが良い」で、その規則が正しい指摘まで
    落とすことが分かったためである（「然」は常用漢字なので消えてしまう）。

    空で返るのはモデルがプロンプトの約束（ひらがなに直した形を書く）を
    守っていないということで、検算で間引く話ではない。
  */
  test("漢字ひらきは、修正案が空でも落とさない", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "然し彼は歩き続けた。",
            suggestion: "",
            reason: "漢字ひらき",
            explanation: "「然し（しかし）」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      chunkOf("然し彼は歩き続けた。")
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  /**
   * 推敲の比べ（2026-09-26、教科書チート10話）で、さくらの gemma-4-31B-it と
   * Kimi-K2.6 が、**ひらく字の無い所**に漢字ひらきの札を貼って返した。
   * 説明は「「〜事」という形式名詞が漢字で書かれています」「「暫く」は副詞で…」
   * だが、原文（「記憶が戻って混乱しているらしい」「フッと、目の前にぼんやりと光る」）
   * にその字は無く、修正案も空。**画面には、どこを直すのか分からない指摘が並ぶ。**
   * 修正案が空のときだけ、説明が挙げた漢字が原文にあるかを見る（修正案のある
   * 指摘は、修正案そのものを手前の関門が確かめている）。
   */
  test("説明が挙げた漢字が原文に無く、修正案も空なら落とす", () => {
    const text = chunkOf(
      "記憶が戻って混乱しているらしい。フッと、目の前にぼんやりと光る。しあいやろ！"
    );
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "記憶が戻って混乱しているらしい",
            suggestion: "",
            reason: "漢字ひらき",
            explanation: "「〜事」という形式名詞が漢字で書かれています。",
            confidence: "high",
          },
          {
            line: 11,
            original: "フッと、目の前にぼんやりと光る",
            suggestion: "",
            reason: "漢字ひらき",
            explanation: "「暫く」は副詞で、漢字表記よりひらがなが自然です",
            confidence: "high",
          },
          {
            // 原文に漢字が1字も無い（ひらくものが無い）
            line: 11,
            original: "しあいやろ！",
            suggestion: "",
            reason: "漢字ひらき",
            explanation: "誤記です",
            confidence: "high",
          },
        ],
      },
      text
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "kanji_not_in_original",
      "kanji_not_in_original",
      "kanji_not_in_original",
    ]);
  });

  test("説明が読みを添えて挙げた漢字（「所謂（いわゆる）」）が原文にあれば、空でも通す", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "所謂、彼は殆ど",
            suggestion: "",
            reason: "漢字ひらき",
            explanation: "「所謂（いわゆる）」と「殆ど」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      kanji
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  test("語尾単調は、修正案が空のまま通る", () => {
    // **どの文をどう変えるかは文体そのもの**なので、作者が決める
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 12,
            original: "彼は歩いた。彼は走った。彼は止まった。",
            suggestion: "",
            reason: "語尾単調",
            explanation: "「〜た。」で終わる文が3連続です",
            confidence: "medium",
          },
        ],
      },
      chunk
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("");
  });

  /**
   * **作者が名指しで守った語は、新しい観点でも守られる。**
   * 推敲は原文まるごとを置き換えるので、守る語が原文に入っていれば
   * 必ず巻き込む。固有名詞・作品の造語をひらかれると作品が壊れる。
   */
  test.each([
    ["漢字ひらき", "所謂", "いわゆる"],
    ["語尾単調", "所謂", ""],
  ])("直さない語を含む %s の指摘は出さない", (reason, original, suggestion) => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original,
            suggestion,
            reason,
            explanation: "読みが詰まります",
            confidence: "high",
          },
        ],
      },
      kanji,
      [{ word: "所謂", note: "この作品の言い回し", addedAt: "2026-08-27" }]
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("kept_word");
  });

  test("札は増えたが、選択肢を写した返し方も拾える", () => {
    // 実データで起きた形（設計書6.10.1）。6つに増えても同じ
    expect(normalizeReason("漢字ひらき：読みが詰まります")).toBe("漢字ひらき");
    expect(normalizeReason("語尾単調")).toBe("語尾単調");
  });
});

describe("弾く提案", () => {
  test("本文に無い原文を弾く", () => {
    // 言い換えた「原文」を返すことがあり、適用するとどこにも当たらない
    const result = validateProofreadIssues(
      { issues: [item({ original: "はじめに彼は" })] },
      chunk
    );

    expect(result.rejected[0].reason).toBe("original_not_found");
  });

  test("決めた6種類以外の理由を弾く", () => {
    // **文体への干渉が紛れ込む口を塞ぐ**
    for (const reason of ["語彙", "リズム", "描写不足", "もっと小説らしく"]) {
      const result = validateProofreadIssues(
        { issues: [item({ reason })] },
        chunk
      );
      expect(result.rejected[0]?.reason, reason).toBe("unknown_reason");
    }
  });

  test("変わっていない提案を弾く", () => {
    // 押しても何も起きない
    const result = validateProofreadIssues(
      { issues: [item({ suggestion: "まず最初に" })] },
      chunk
    );

    expect(result.rejected[0].reason).toBe("no_change");
  });

  test("チャンクの外の行を弾く", () => {
    expect(
      validateProofreadIssues({ issues: [item({ line: 999 })] }, chunk)
        .rejected[0].reason
    ).toBe("line_out_of_range");
  });

  test("形が違うものを弾く", () => {
    const result = validateProofreadIssues(
      { issues: ["冗長です", null, { line: 11 }] },
      chunk
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
  });

  test("応答が空でも落ちない", () => {
    expect(validateProofreadIssues(null, chunk).accepted).toEqual([]);
  });
});

/**
 * 実データ（いじめられっ子・gemma4:e4b）で実際に返ってきたものを固定する。
 *
 * **禁じた観点が、許した札を着て入ってきた。** 札だけ見ていると素通りする。
 */
describe("実データで見つかった、通してはいけない提案", () => {
  test("「長文」の札だが、長文でない箇所を弾く", () => {
    // 「文の区切りが連続しており、流れがやや急ぎ足」のような**文体の話**に
    // この札が付いてくる
    const short = chunkOf("彼は歩いた。彼は走った。");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "彼は歩いた。彼は走った。",
            suggestion: "",
            reason: "長文",
            explanation: "文の区切りが連続しています",
            confidence: "medium",
          },
        ],
      },
      short
    );

    expect(result.rejected[0].reason).toBe("not_long");
  });

  test("本当の長文は通す", () => {
    // 一文が80字を超え、読点が5個以上
    const long =
      "彼は、朝早くに起きて、顔を洗い、着替えを済ませ、鞄を持って、玄関を出て、" +
      "駅までの道を急ぎ足で歩き、いつもの電車に間に合うように改札を抜け、" +
      "席に座って本を開き、目的の駅まで一度も顔を上げなかった。";
    expect(long.length).toBeGreaterThan(80);
    expect(hasLongSentence(long)).toBe(true);
    expect(hasLongSentence("短い文。もう一つ短い文。")).toBe(false);
  });

  test("「同語反復」の札だが、繰り返しが無い箇所を弾く", () => {
    const text = chunkOf("コメント欄には、ばっちり名前が出てしまっていた。");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "コメント欄には、ばっちり名前が出てしまっていた。",
            suggestion: "",
            reason: "同語反復",
            explanation: "「ばっちり」がやや砕けています",
            confidence: "low",
          },
        ],
      },
      text
    );

    expect(result.rejected[0].reason).toBe("not_repeated");
  });

  test("本当の繰り返しは通す", () => {
    expect(hasRepetition("母さんも怒鳴り返している。母さんが怒鳴っている。")).toBe(
      true
    );
    // 2文字の並び（「ている」など）はどの文にも出るので、境は3文字
    expect(hasRepetition("彼は走った。")).toBe(false);
  });

  /**
   * **指示と検算が食い違っていた**（2026-09-24 の縛りの洗い出し6番）。
   * 指示は「original は5〜30字の短い範囲でかまいません」、検算は
   * 「original の**中に**長文・繰り返しがあること」。指示どおり短く
   * 写すと、本物の長文も、行をまたぐ繰り返しも必ず落ちていた。
   * 検算は、写した範囲を含む文・前後の段落で数える。
   */
  describe("写した範囲の外を見る（2026-09-24）", () => {
    // 答え付きの台（seeded/proofread 第3話）の25〜27行目をそのまま写す
    const episode3 = {
      filePath: "本文/003_よる.txt",
      index: 0,
      text: [
        "　窓の外では、波の音が静かに響いていた。遠くで漁船のエンジン音がして、また静かになった。母は写真を丁寧に箱へしまい、湯呑みにお茶を注いだ。",
        "",
        "　海斗はお茶を一口飲み、写真の中の若い母の顔をもう一度思い浮かべた。同じ港でも、時代が違えば見える景色も違うのだろうと思うと、不思議な気持ちになった。壁の時計が、静かに十時を告げた。",
        "",
        "　母はお茶を一口飲み、湯呑みを卓袱台に置く。壁の時計の音だけが、静かな部屋に響いていた。",
      ].join("\n"),
      startLine: 22,
      chapterStart: 3,
      chapterEnd: 3,
      hash: "ep3",
      segments: [],
    } as unknown as Chunk;

    test("実測の not_repeated（25行目と27行目の「お茶を一口飲み」）を通す", () => {
      const result = validateProofreadIssues(
        {
          issues: [
            {
              confidence: "medium",
              explanation: "「お茶を一口飲み」が25行目と27行目で繰り返されています",
              line: 27,
              original: "母はお茶を一口飲み",
              reason: "同語反復",
              suggestion: "",
            },
          ],
        },
        episode3
      );

      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
    });

    /**
     * 推敲の比べ（2026-09-26、教科書チート5話・8話）で、本物の繰り返しが
     * not_repeated で落ちた。範囲の外で数えるのが「漢字か片仮名を含む3字」だけなので、
     * **2字の熟語（説明）と、仮名だけの語（そのまま）の繰り返しは数えられなかった。**
     * 説明が「」で挙げた語が本文の近くに2回以上あれば、繰り返しとして通す。
     */
    const episode5 = {
      filePath: "episode_0005.txt",
      index: 0,
      text: [
        "　僕はしどろもどろになりながら説明した。授業で習った基礎的な説明から始めて、マシンガンのように説明する。",
        "",
        "　父上はそのまま、はしゃぐリナを振り回し、そのままストンと地面に降ろした。リナはそのまま義母さんに抱きつく。",
        "",
        // 件数の上限（1000字あたり5件）で2件目が切られないよう、字数を足す
        `　${"遠くの山に雲がかかっていた。".repeat(30)}`,
      ].join("\n"),
      startLine: 134,
      chapterStart: 5,
      chapterEnd: 5,
      hash: "ep5",
      segments: [],
    } as unknown as Chunk;

    test("説明が挙げた2字の熟語・仮名の語が近くで繰り返されていれば通す", () => {
      const result = validateProofreadIssues(
        {
          issues: [
            {
              confidence: "medium",
              explanation: "「説明」が135行の一文だけで3回出ています",
              line: 135,
              original: "マシンガンのように説明する",
              reason: "同語反復",
              suggestion: "",
            },
            {
              confidence: "medium",
              explanation: "「そのまま」が2文で3回出ています",
              line: 137,
              original: "そのままストンと地面に降ろした",
              reason: "同語反復",
              suggestion: "",
            },
          ],
        },
        episode5
      );

      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(2);
    });

    test("説明が挙げた語が、写した範囲に無い・近くに1回しか無い・短い仮名なら通さない", () => {
      const result = validateProofreadIssues(
        {
          issues: [
            {
              // 「授業」は近くに1回しか無い
              confidence: "medium",
              explanation: "「授業」が繰り返されています",
              line: 135,
              original: "授業で習った基礎的な",
              reason: "同語反復",
              suggestion: "",
            },
            {
              // 挙げた語が写した範囲に無い（別の所の話）
              confidence: "medium",
              explanation: "「説明」が3回出ています",
              line: 137,
              original: "義母さんに抱きつく",
              reason: "同語反復",
              suggestion: "",
            },
            {
              // 仮名3字以下はどの段落にも出るので数えない
              confidence: "medium",
              explanation: "「した」が繰り返されています",
              line: 135,
              original: "しどろもどろになりながら",
              reason: "同語反復",
              suggestion: "",
            },
          ],
        },
        episode5
      );

      expect(result.accepted).toEqual([]);
      expect(result.rejected.map((entry) => entry.reason)).toEqual([
        "not_repeated",
        "not_repeated",
        "not_repeated",
      ]);
    });

    test("近くに繰り返しの無い「同語反復」は、今までどおり落とす", () => {
      // 1件目は前後の段落にも無い語。2件目は「になった」だけが23行目と
      // 重なる——**仮名だけの3字の一致は数えない**。どの段落にも出るので、
      // それで通すと網が無いのと同じになる
      const result = validateProofreadIssues(
        {
          issues: [
            {
              confidence: "medium",
              explanation: "繰り返しています",
              line: 27,
              original: "卓袱台に置く",
              reason: "同語反復",
              suggestion: "",
            },
            {
              confidence: "medium",
              explanation: "繰り返しています",
              line: 25,
              original: "不思議な気持ちになった",
              reason: "同語反復",
              suggestion: "",
            },
          ],
        },
        episode3
      );

      expect(result.accepted).toEqual([]);
      expect(result.rejected.map((entry) => entry.reason)).toEqual([
        "not_repeated",
        "not_repeated",
      ]);
    });

    test("短く写した範囲でも、それを含む一文が長文なら通す", () => {
      const longSentence =
        "　彼は、朝早くに起きて、顔を洗い、着替えを済ませ、鞄を持って、玄関を出て、" +
        "駅までの道を急ぎ足で歩き、いつもの電車に間に合うように改札を抜け、" +
        "席に座って本を開き、目的の駅まで一度も顔を上げなかった。夜が明けた。";
      const result = validateProofreadIssues(
        {
          issues: [
            {
              line: 11,
              original: "鞄を持って、玄関を出て",
              suggestion: "",
              reason: "長文",
              explanation: "一文が長く、読点が多いです",
              confidence: "medium",
            },
          ],
        },
        chunkOf(longSentence)
      );

      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
    });

    test("短く写した範囲を含む文が短ければ、今までどおり not_long", () => {
      // 実測の not_long の1件（14字の断片）と同じ形。前後に長い文があっても、
      // **写した範囲を含む文**だけを見る
      const text =
        "　手を洗いに洗面所へ向かった。彼は、朝早くに起きて、顔を洗い、着替えを済ませ、鞄を持って、玄関を出て、" +
        "駅までの道を急ぎ足で歩き、いつもの電車に間に合うように改札を抜け、" +
        "席に座って本を開き、目的の駅まで一度も顔を上げなかった。";
      const result = validateProofreadIssues(
        {
          issues: [
            {
              line: 11,
              original: "手を洗いに洗面所へ向かった。",
              suggestion: "",
              reason: "長文",
              explanation: "一文が長いです",
              confidence: "medium",
            },
          ],
        },
        chunkOf(text)
      );

      expect(result.rejected.map((entry) => entry.reason)).toEqual([
        "not_long",
      ]);
    });
  });

  /**
   * 作者の10作品・44,000字で測ったときに実際に挙がったもの
   * （gemma4:e4b、2026-08-17）。
   *
   * **繰り返しは本当にあるが、それは人物の喋り方だった。**
   * `hasRepetition` は数えるだけなので、ここは素通りしていた。
   */
  describe("台詞の中の繰り返しは、人物の話し方として通さない", () => {
    test.each([
      // 関西弁（長命ハイエルフの投資運用）
      "「あんた、クォーターやろ？　なんゆうてまんのや？　そやかて」",
      // わざと崩した喋り（短編 N1071IJ）
      "「わた、く、しは、で　んかを、あいして　い ます……」",
      // 強調の反復（長命ハイエルフの投資運用）
      "「商人は帝国を打倒したりせぇへん。商人は商人らしく、遠慮なく稼いだれ」",
      // 台詞が2つ続く場合も、地の文は無い
      "「行こう」「行かない」",
    ])("弾く: %s", (original) => {
      expect(isDialogueOnly(original)).toBe(true);
    });

    test.each([
      // 地の文の対句。直すかどうかは作者が決める
      "ある者は主人に報告に、ある者は店員を呼び集めるために駆け込んでいく。",
      // 台詞に地の文が続く形
      "「行こう」と彼は言った。彼はまた言った。",
      // 台詞そのものが無い
      "母さんも怒鳴り返している。母さんが怒鳴っている。",
    ])("通す: %s", (original) => {
      expect(isDialogueOnly(original)).toBe(false);
    });

    test("検証の流れの中でも弾かれる", () => {
      const line = "「商人は打倒せぇへん。商人は商人らしく稼いだれ」";
      const result = validateProofreadIssues(
        {
          issues: [
            {
              line: 11,
              original: line,
              suggestion: "",
              reason: "同語反復",
              explanation: "「商人は」が繰り返されています",
              confidence: "medium",
            },
          ],
        },
        chunkOf(line)
      );

      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0].reason).toBe("dialogue_voice");
    });

    /**
     * 推敲の比べ（2026-09-26、教科書チート9話）で、Kimi-K2.6 と Qwen3.6 が
     * 台詞の中身を**括弧を付けずに**写して同語反復の札を貼った（「骨喰牛はその
     * ゾンビやスケルトンを食べるおとなしい魔物だよ」「おとなしいのに、何でみんな
     * 警戒してるの？」）。原文だけを見ると地の文に見えるので、本文の行の中で
     * 台詞の括弧の内側にあるかを確かめる
     */
    test("括弧を付けずに写した台詞の中身も、本文で台詞の内側なら弾く", () => {
      const text = chunkOf(
        "「骨喰牛はおとなしい魔物だよ」\n「おとなしいのに、何でみんな警戒してるの？」"
      );
      const result = validateProofreadIssues(
        {
          issues: [
            {
              line: 12,
              original: "おとなしいのに、何でみんな警戒してるの？",
              suggestion: "",
              reason: "同語反復",
              explanation: "「おとなしい」が2文で2回出ています",
              confidence: "medium",
            },
          ],
        },
        text
      );

      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0].reason).toBe("dialogue_voice");
    });
  });

  test.each([
    "「なんか」が口語的で、やや唐突に感じます",
    "表現が文脈に合っていません",
    "リズムが単調です",
    "描写が物足りません",
  ])("説明が禁じた観点を語っていたら弾く: %s", (explanation) => {
    expect(mentionsForbiddenAspect(explanation)).toBe(true);
  });

  test.each([
    "同じ意味が重なっています",
    "修飾の関係が2通りに読めます",
    "「母さん」が近くで繰り返されています",
  ])("許した観点の説明は通す: %s", (explanation) => {
    expect(mentionsForbiddenAspect(explanation)).toBe(false);
  });

  test("札が正しくても、説明が文体の話なら弾く", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          item({ explanation: "「なんか」が口語的で、文脈上やや唐突です" }),
        ],
      },
      chunk
    );

    expect(result.rejected[0].reason).toBe("forbidden_aspect");
  });
});

describe("修正案が無い提案", () => {
  test("修正案が空でも受け入れる", () => {
    // 長すぎる文をどう割るかは文体の書き換えになる。**それは作者が決めること**
    const result = validateProofreadIssues(
      { issues: [item({ suggestion: "" })] },
      chunk
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("");
  });

  test("原文が無ければ、やはり弾く", () => {
    // どこの話か分からない指摘は使えない
    expect(
      validateProofreadIssues({ issues: [item({ original: "" })] }, chunk)
        .rejected[0].reason
    ).toBe("shape");
  });
});

describe("出しすぎを切る", () => {
  // **上限の値を書き写さない**（2026-09-18 に 3 → 5 へ変えて、ここが落ちた）。
  // 確かめたいのは「1000字あたりの件数に比例すること」であって、値そのものではない
  test("1000字あたり、決めた件数まで", () => {
    expect(issueBudget(1000)).toBe(MAX_ISSUES_PER_1000_CHARS);
    expect(issueBudget(4000)).toBe(MAX_ISSUES_PER_1000_CHARS * 4);
  });

  test("短い本文でも1件は挙げられる", () => {
    // 0件だと、短いチャンクでは何も指摘できなくなる
    expect(issueBudget(100)).toBe(1);
    expect(issueBudget(0)).toBe(1);
  });

  test("上限を超えたぶんを弾く", () => {
    // **ここが無いと、全部の文に提案が付いた状態が作者へ届く**
    const text = "あ".repeat(1000);
    // 上限より必ず多く送る（上限の値が変わっても、弾かれることを確かめられる）
    const sent = MAX_ISSUES_PER_1000_CHARS + 7;
    const many = Array.from({ length: sent }, (_, index) => ({
      line: 11,
      original: "あ".repeat(index + 2),
      suggestion: `直し${index}`,
      reason: "冗長",
      explanation: "",
      confidence: "high",
    }));

    const result = validateProofreadIssues({ issues: many }, chunkOf(text));

    expect(result.accepted).toHaveLength(MAX_ISSUES_PER_1000_CHARS);
    expect(
      result.rejected.filter((entry) => entry.reason === "over_budget")
    ).toHaveLength(sent - MAX_ISSUES_PER_1000_CHARS);
  });

  test("切るときは確信度の高いものを残す", () => {
    // 迷っている提案だけが手元に来ては、質の低いものを読まされる
    // **上限がちょうど1件になる長さを、定数から出す**（400字と書き写すと、
    // 1000字あたりの件数を変えたときに上限が2件になって落ちる。実際に落ちた）
    const text = "あ".repeat(Math.round(1000 / MAX_ISSUES_PER_1000_CHARS));
    const issues = [
      {
        line: 11,
        original: "ああ",
        suggestion: "い",
        reason: "冗長",
        explanation: "",
        confidence: "low",
      },
      {
        line: 11,
        original: "あああ",
        suggestion: "う",
        reason: "冗長",
        explanation: "",
        confidence: "high",
      },
    ];

    const result = validateProofreadIssues({ issues }, chunkOf(text));

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].confidence).toBe("high");
  });
});

describe("理由の読み取り", () => {
  test("選択肢を写して返されても拾う", () => {
    // 矛盾検知で実際に起きた形（設計書6.10.1）
    expect(normalizeReason("冗長|同語反復|係り受け|長文|漢字ひらき|語尾単調")).toBe(
      "冗長"
    );
    expect(normalizeReason("同語反復：近い範囲で…")).toBe("同語反復");
  });

  test("知らない語は決めない", () => {
    expect(normalizeReason("語彙")).toBeUndefined();
    expect(normalizeReason("")).toBeUndefined();
  });
});

/**
 * **札を足したのに決まり文句を足し忘れる**と、その種類だけ画面から
 * 説明が消える（AIが explanation を返さなかったときに何も出なくなる）。
 * 種類は増えていくので、1つずつ書き並べるのではなく、一覧から確かめる。
 */
describe("種類ごとの決まり文句", () => {
  test.each(PROOFREAD_REASONS)("%s には言葉がある", (reason) => {
    expect(explainProofreadReason(reason)).toBeTruthy();
  });

  test("推敲以外の種類には足さない", () => {
    // 誤字脱字の `reason` は説明そのものなので、重ねる言葉は無い
    expect(explainProofreadReason("誤字")).toBeUndefined();
  });
});

describe("並べ方", () => {
  test("確信度の高いものを上に", () => {
    const make = (
      confidence: "high" | "medium" | "low",
      line: number
    ): AcceptedProofreadIssue => ({
      line,
      original: "x",
      target: "x",
      suggestion: "y",
      reason: "冗長",
      explanation: "",
      confidence,
    });

    expect(
      sortProofreadIssues([make("low", 1), make("high", 2), make("medium", 3)])
        .map((entry) => entry.confidence)
    ).toEqual(["high", "medium", "low"]);
  });
});

/**
 * 新観点（1.5）の検収で入れた2つの防御（本体、2026-08-28）。
 *
 * 1. 語尾単調の説明としてモデルが自然に書くのは「リズムが単調」で、
 *    これが禁止語の網に掛かると**新観点の指摘が全部落ちる**。
 *    札そのものがその観点の話である場合だけ、その語を許す。
 * 2. 語尾単調の原文は複数文で、50字制限で途中まで切れていることがある。
 *    そこへ修正案が付くと切れた範囲がまるごと置き換わるので、コードで空にする。
 */
describe("新観点の説明と修正案の防御", () => {
  // **本文は本当に「た。」が4連続していなければならない**（2026-09-04）。
  // 語尾の連続をコードで数え直すようにしたため、以前の
  // 「彼は走った。彼は跳んだ。彼は飛んだ。彼は泳いだ。」（た。だ。だ。だ。）は
  // 4連続が無く、ここで確かめたい防御まで届かなくなった
  const chunk = {
    text: "彼は走った。彼は歩いた。彼は跳ねた。彼は笑った。",
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
  } as never;

  test("語尾単調の説明の「リズム」は弾かない", () => {
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "彼は走った。彼は歩いた。彼は跳ねた。",
            suggestion: "",
            reason: "語尾単調",
            explanation: "「〜た。」で終わる文が続き、リズムが単調です",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  test("語尾単調でも、文体そのものの話は弾いたまま", () => {
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "彼は走った。彼は歩いた。彼は跳ねた。",
            suggestion: "",
            reason: "語尾単調",
            explanation: "文体が単調で、描写に工夫がありません",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toBe("forbidden_aspect");
  });

  test("冗長の説明の「リズム」は、これまでどおり弾く", () => {
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "彼は走った。彼は歩いた。",
            suggestion: "",
            reason: "冗長",
            explanation: "リズムが悪く冗長です",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toBe("forbidden_aspect");
  });

  test("語尾単調に修正案が付いてきても、コードで空にする", () => {
    const { accepted } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "彼は走った。彼は歩いた。彼は跳ねた。",
            suggestion: "彼は走った。歩いたかと思えば、軽やかに跳ねている。",
            reason: "語尾単調",
            explanation: "「〜た。」で終わる文が4連続です",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].suggestion).toBe("");
  });
});

/**
 * 常用漢字表との照合の注記（作者の指定、2026-08-28）。
 *
 * 判定はAIにさせない（表を正確に覚えていない）。コードで照合し、
 * **参考として**添える——ひらくかどうかは作者の判断が優先。
 */
describe("漢字ひらきへの常用漢字表の注記", () => {
  const chunk = {
    text: "悍ましい夜だった。然し彼は歩き続けた。",
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
  } as never;

  function acceptedOf(
    original: string,
    explanation: string,
    suggestion = ""
  ) {
    return validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion,
            reason: "漢字ひらき",
            explanation,
            confidence: "high",
          },
        ],
      },
      chunk
    ).accepted;
  }

  test("表に無い字は、参考として説明に添えられる", () => {
    const accepted = acceptedOf(
      "悍ましい夜だった。",
      "「悍ましい（おぞましい）」で読みが詰まります"
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].explanation).toContain("「悍」は常用漢字表");
    expect(accepted[0].explanation).toContain("平成22年内閣告示第2号");
  });

  test("表の字だけなら、注記は付かない", () => {
    // **修正案を渡す。** 空のまま表の字だけだと、作者に渡すものが1つも
    // 無いので指摘ごと落ちる（下の「渡すものが1つも無い」の節）。
    // ここで見たいのは注記が付かないことなので、落ちない形で確かめる
    const accepted = acceptedOf(
      "然し彼は歩き続けた。",
      "「然し（しかし）」で読みが詰まります",
      "しかし彼は歩き続けた。"
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].explanation).not.toContain("常用漢字表");
  });

  test("決まり文句に「作者の判断が優先」が入っている", () => {
    expect(explainProofreadReason("漢字ひらき")).toContain(
      "作者の判断が優先"
    );
  });
});

/**
 * 音読みで普通に読める熟語をひらかない（作者の報告、2026-09-12）。
 *
 * 実データで、こう出た。
 *
 *   基礎学力六十点、人物適性百点、遺伝適性百点、実技加点八十点。
 *   → きそがくりょく六十点、じんぶつてきせい百点、…
 *
 * 作者の言葉は「『基礎学力』などをひらく意味がわかりません」である。
 * **音読みをつないだだけの熟語は、かなにしても読みやすくならない。**
 */
describe("音読みの熟語はひらかない", () => {
  function resultOf(original: string, suggestion: string) {
    return validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion,
            reason: "漢字ひらき",
            explanation: "漢字が続いていて読みに詰まります",
            confidence: "high",
          },
        ],
      },
      { text: original, startLine: 0, chapterStart: 1, chapterEnd: 1 } as never
    );
  }

  test("作者の報告そのもの——4語まとめてひらく案は落ちる", () => {
    const result = resultOf(
      "基礎学力六十点、人物適性百点、遺伝適性百点、実技加点八十点。",
      "きそがくりょく六十点、じんぶつてきせい百点、いでんてきせい百点、じつぎかてん八十点。"
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("onyomi_compound");
  });

  test("1語だけでも落ちる", () => {
    const result = resultOf("基礎学力の試験だった。", "きそがくりょくの試験だった。");

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("onyomi_compound");
  });

  /**
   * **本当のひらきを巻き込まない。** 音読みをつないだ形と一致しないので、
   * 関門は素通りする（表外字を含むものは、そもそも読みを組めない）。
   */
  test.each([
    ["出来る", "できる"],
    ["所謂、彼は強い。", "いわゆる、彼は強い。"],
    ["殆ど眠れなかった。", "ほとんど眠れなかった。"],
    // 1字は対象外（「然」に許された音は「ゼン」「ネン」だけで、
    // 「しかし」は表の範囲外の読みである）
    ["然し彼は歩いた。", "しかし彼は歩いた。"],
  ])("本当のひらき（%s）は通る", (original, suggestion) => {
    const result = resultOf(original, suggestion);

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  /**
   * **当て字は、音読みで一致しても落とさない**（作者の裁定、2026-09-12）。
   *
   * 丁（チョウ）＋度（ド）＝ちょうど、沢（タク）＋山（サン）＝たくさん、
   * 是（ゼ）＋非（ヒ）＝ぜひ。音読みをつなぐと読みと一致してしまうが、
   * どれも**常用漢字表に無い使い方**なので、ひらくよう勧めたい語である。
   *
   * 見分けには**表記ゆれの一覧**（`KANA_KANJI_PAIRS`）を使う。作者が既に
   * 「ひらくことを勧める」と決めた一覧なので、例外の一覧を別に作らない。
   *
   * **表記ゆれの側では代われない。** あちらは漢字とかなの両方が本文に
   * あるときしか出ない（揺れを見る仕組み）ので、漢字で通している箇所は
   * ここで落とすとどこからも届かなくなる（9巡目に測って分かった）。
   */
  test.each([
    ["丁度そのとき、鐘が鳴った。", "ちょうどそのとき、鐘が鳴った。"],
    ["沢山の人がいた。", "たくさんの人がいた。"],
    ["素敵な帽子だ。", "すてきな帽子だ。"],
    ["是非とも来てほしい。", "ぜひとも来てほしい。"],
    ["大丈夫だと言った。", "だいじょうぶだと言った。"],
    ["折角の休みだった。", "せっかくの休みだった。"],
  ])(
    "当て字（%s）は、音読みで一致しても通る",
    (original, suggestion) => {
      const result = resultOf(original, suggestion);

      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
    }
  );

  test("勧めていない熟語は、これまでどおり落ちる（例外を広げすぎていない）", () => {
    // 「基礎学力」は表記ゆれの一覧に無いので、関門がそのまま効く
    const result = resultOf("基礎学力の試験だった。", "きそがくりょくの試験だった。");

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("onyomi_compound");
  });

  test("「漢字ひらき」以外の札には、この関門をかけない", () => {
    // 同じ置き換えでも、札が違えば見ない（観点ごとの検算を混ぜない）
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "基礎学力基礎学力",
            suggestion: "きそがくりょく",
            reason: "同語反復",
            explanation: "同じ語が並んでいます",
            confidence: "high",
          },
        ],
      },
      {
        text: "基礎学力基礎学力",
        startLine: 0,
        chapterStart: 1,
        chapterEnd: 1,
      } as never
    );

    expect(result.accepted).toHaveLength(1);
  });
});

/**
 * **指示に書いた語が、答えの中身として返ってくる**（CLAUDE.md の
 * 「繰り返し起きた失敗」3番。`"suggestion": "空文字"` がその実例）。
 *
 * P-10 の 1.7 で、漢字ひらきの規則へ「副詞の当て字（丁度・沢山・是非・折角
 * など）」という一行を足した。**「当て字」という語が修正案として返ってくる
 * 前提で検査を書く。** 原文が短いと `dropsOriginalTail`（半分以上が消える）
 * も効かないので、「丁度」が「当て字」に置き換わって本文へ入りうる。
 *
 * **落とすのは修正案だけで、指摘は残す**（「空文字」と同じ扱い）。
 * どの語をひらくかという指摘そのものは正しいことが多く、
 * **原稿を壊すより、直し方を作者に委ねるほうがよい。**
 */
describe("漢字ひらきの修正案に、指示の言葉が紛れ込んだとき", () => {
  function openingIssue(original: string, suggestion: string) {
    return validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion,
            reason: "漢字ひらき",
            explanation: `「${original}」で読みが詰まります`,
            confidence: "high",
          },
        ],
      },
      { text: original, startLine: 0, chapterStart: 1, chapterEnd: 1 } as never
    );
  }

  test.each([
    ["丁度", "当て字"],
    ["沢山", "副詞"],
    ["是非", "難読"],
    ["折角", "連体詞"],
  ])(
    "原文（%s）に無い漢字が入った修正案（%s）は、修正案だけ空にする",
    (original, suggestion) => {
      const result = openingIssue(original, suggestion);

      // 指摘は残す（どこを見ればよいかは正しい情報である）
      expect(result.accepted).toHaveLength(1);
      // **本文へ当てられる形では残さない**
      expect(result.accepted[0].suggestion).toBe("");
    }
  );

  test.each([
    ["丁度そのとき、鐘が鳴った。", "ちょうどそのとき、鐘が鳴った。"],
    ["沢山の人がいた。", "たくさんの人がいた。"],
    ["是非とも来てほしい。", "ぜひとも来てほしい。"],
    ["折角の休みだった。", "せっかくの休みだった。"],
    // 漢字が残るひらき方（補助動詞だけをひらく）も巻き込まない
    ["置いて見る。", "置いてみる。"],
  ])("本当にひらいた修正案（%s）は、そのまま残る", (original, suggestion) => {
    const result = openingIssue(original, suggestion);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe(suggestion);
  });
});

/**
 * 原文が行の中で一意でないとき（P-10 1.8）。
 *
 * 1.8 で **`original` を「直す語を含む短い範囲（5〜30字）」にしてよい**と
 * 書いた。短いほど `suggestion` が同じ範囲の書き換えになりやすい一方で、
 * **同じ語が1行に2回ある**ことが現実に起きる。
 *
 * 適用は**行の中の最初の一致**へ当たる（`features/proposalPanel.ts` の
 * `lineText.indexOf(item.original)`）。AIが2つ目のつもりで挙げていても
 * **黙って1つ目が書き換わる**——作者の原稿が、指摘と違う場所で変わる。
 *
 * **落とすのは修正案だけで、指摘は残す**（作者の裁定、2026-09-17。
 * `dropsOriginalTail`・`introducesNewKanji` と同じ形）。空の修正案は
 * 押せないので原稿は動かず、「この行に直す語がある」は正しい情報である。
 */
describe("行の中で一意でない原文", () => {
  function openingIssue(text: string, original: string) {
    return validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original,
            suggestion: "ちょうど",
            reason: "漢字ひらき",
            explanation: `「${original}（ちょうど）」で読みが詰まります`,
            confidence: "high",
          },
        ],
      },
      chunkOf(text)
    );
  }

  test("同じ行に2回出る原文は、修正案だけ空にする", () => {
    const result = openingIssue(
      "彼は丁度そこにいた。彼は丁度そこで待っていた。",
      "丁度"
    );

    // 指摘は残す（「この行に直す語がある」は正しい情報である）
    expect(result.accepted).toHaveLength(1);
    // **本文へ当てられる形では残さない**（押しても原稿は動かない）
    expect(result.accepted[0].suggestion).toBe("");
    expect(result.rejected).toHaveLength(0);
  });

  test("行の中で一度しか出ない原文は、これまでどおり通る", () => {
    const result = openingIssue("彼は丁度そこにいた。", "丁度");

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("ちょうど");
  });

  test("同じ語でも、行が違えば一意である", () => {
    // 行をまたいで2回出るのは曖昧ではない（適用はその行の中だけを見る）
    const result = openingIssue("彼は丁度そこにいた。\n丁度そのとき。", "丁度");

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("ちょうど");
  });

  test("語尾単調は、錨が行に何度も出ていても指摘として残る", () => {
    // 連続の先頭の文（`run.first`）は本文から数えて選んでいる。
    // AIの言い値ではないので、同じ文が並んでいても取り違えは起きない
    // （修正案はもともとコードで空にしている）
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "彼は走った。",
            suggestion: "",
            reason: "語尾単調",
            explanation: "同じ語尾が続いています",
            confidence: "high",
          },
        ],
      },
      chunkOf("彼は走った。彼は走った。彼は走った。彼は走った。")
    );

    expect(result.accepted).toHaveLength(1);
  });
});

/**
 * 出力例に書いた語が、そのまま答えとして返ってきたとき（P-10 1.8）。
 *
 * **指示の言葉は答えの中身として返ってくる**（この作品で繰り返し起きた
 * 失敗の3番。`"suggestion": "空文字"` がその実例）。1.8 で
 * 【出力形式】の例へ漢字ひらきの1件（「是非この鯵を持って」→
 * 「ぜひこの鯵を持って」）を足したので、**例の一文がそのまま返る**道ができた。
 *
 * 受けるのは既にある関門である——**原文が本文に実在しなければ出さない**
 * （`original_not_found`）。例の一文は別の作品の本文には無いので、
 * ここで止まる。
 */
describe("出力例の語がそのまま返ってきたとき", () => {
  test("例の一文は、本文に無いので落ちる", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "是非この鯵を持って",
            suggestion: "ぜひこの鯵を持って",
            reason: "漢字ひらき",
            explanation: "「是非（ぜひ）」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      chunk
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("original_not_found");
  });

  test("本文に実在すれば、当て字の指摘として通る", () => {
    // 例と同じ語でも、本文にあるなら正しい指摘である
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "是非この鯵を持って",
            suggestion: "ぜひこの鯵を持って",
            reason: "漢字ひらき",
            explanation: "「是非（ぜひ）」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      chunkOf("是非この鯵を持って帰ってほしい。")
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("ぜひこの鯵を持って");
  });
});

/**
 * 漢字ひらきの修正案が、**ひらきではなく言い換え**だったとき（P-10 1.8）。
 *
 * 1.8 の測定で gemma4:12b が「然し」→「でも」を返した。意味は近いが
 * **ひらいた形ではない**——押すと本文の「然し」が「でも」になり、
 * **作者の文体がモデルの語彙で置き換わる。** 漢字は増えていないので
 * `introducesNewKanji` は通し、原文が2字では `dropsOriginalTail` も効かない。
 *
 * **読みの辞書は使わない。** 常用漢字表の音訓で見ると「然し（しかし）」は
 * 表外の読みで、表で判定する規則は**正しい指摘まで落とす**
 * （作者が 2026-09-12 に取り下げさせた規則そのもの）。見るのは
 * 「ひらく＝漢字をかなにする」という定義から機械的に決まることだけである。
 *
 * **落とすのは修正案だけで、指摘は残す**（作者の裁定、2026-09-17。
 * `introducesNewKanji`・`isAmbiguousInLine` と同じ形）。
 */
describe("漢字ひらきの修正案が言い換えだったとき", () => {
  test.each([
    ["然し", "でも"],
    ["殆ど", "ほぼ"],
    ["然し、私は帰った", "だが、私は帰った"],
    // 短すぎる修正案（漢字1字の読みは1音以上あるので、縮むことはない）
    ["然し", "し"],
    // 原文に無い漢字は `introducesNewKanji` の担当だが、ここでも落ちる
    ["然し", "然し乍ら"],
  ])("「%s」→「%s」は言い換えとみなす", (original, suggestion) => {
    expect(paraphrasesInsteadOfOpening(original, suggestion)).toBe(true);
  });

  test.each([
    ["然し", "しかし"],
    ["出来る", "できる"],
    ["丁度", "ちょうど"],
    ["殆ど", "ほとんど"],
    // 原文にある漢字は、そのまま残っていてよい
    ["基礎学力は出来る", "基礎学力はできる"],
  ])("本当にひらいた「%s」→「%s」は通す", (original, suggestion) => {
    expect(paraphrasesInsteadOfOpening(original, suggestion)).toBe(false);
  });

  test("空の修正案は、この関門では扱わない", () => {
    // 空は別の扱い（指摘だけ残す形として、既に通っている）
    expect(paraphrasesInsteadOfOpening("然し", "")).toBe(false);
  });

  test("送り仮名が同じ言い換えは、知っていて通す取りこぼしである", () => {
    // 読みの辞書なしに「出来→やれ」と「然→しか」は区別できない。
    // **正しいひらきを落とす側には倒さない**ので、ここは通る。
    // 見分けられるようになったら、このテストが落ちて気づける
    expect(paraphrasesInsteadOfOpening("出来る", "やれる")).toBe(false);
  });

  test("検証を通すと、指摘は残り修正案だけが空になる", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "然し",
            suggestion: "でも",
            reason: "漢字ひらき",
            explanation: "「然し」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      { text: "然し", startLine: 0, chapterStart: 1, chapterEnd: 1 } as never
    );

    // 指摘は残す（「ここはひらいたほうがよい」は正しい情報である）
    expect(result.accepted).toHaveLength(1);
    // **本文へ当てられる形では残さない**
    expect(result.accepted[0].suggestion).toBe("");
  });
});
