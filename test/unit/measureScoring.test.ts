import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CONTRADICTION_FEATURES,
  FEATURES,
  RUN_TOOL,
  PROMPT_TOOL,
  assertToolRegistered,
  fixtureDirOf,
  countGeneric,
  formatCompareLines,
  formatSpreadLines,
  measurementFileName,
  metricsOfRun,
  pickFreeName,
  promptToolOf,
  registeredToolNames,
  resultsOfResponse,
  budgetCeilingOf,
  countPackedItems,
  issueBudgetOf,
  maxIssuesPer1000CharsOf,
  scoreContradiction,
  scoreDeviation,
  scoreProofread,
  scoreTypo,
  seededWordCount,
  spreadOfRuns,
  toolNameOf,
} from "../../scripts/measureScoring.mjs";
// **製品の式そのもの**（写しがずれていないことを、ここで突き合わせる）
import {
  MAX_ISSUES_PER_1000_CHARS,
  issueBudget,
} from "../../src/prompts/proofread";
import { deviationBudget } from "../../src/prompts/deviationCheck";

/*
  測定台（`scripts/measure.mjs`）の**数え方**だけを確かめる（設計書6.87.15 の柱3）。

  束も Ollama も要らない。**数え方が間違っていると、測定そのものが嘘になる**
  ——「64件中62件が素通り」のような数字は、数え方を信じられて初めて意味を持つ。
*/

/** 答え（`test/fixtures/seeded/proofread/answers.json` の形を小さく写したもの） */
const ANSWERS = {
  episodes: [
    {
      file: "本文/001_あさ.txt",
      ateji: [
        { word: "丁度", reading: "ちょうど", count: 1 },
        { word: "沢山", reading: "たくさん", count: 1 },
      ],
      mustOpen: [
        { word: "然し", reading: "しかし", count: 1 },
        { word: "殆ど", reading: "ほとんど", count: 1 },
      ],
      mustNotOpen: [{ word: "素敵", count: 2 }],
      verbTraps: [{ word: "置く", count: 2 }],
    },
  ],
};

function accepted(
  original: string,
  suggestion: string,
  reason = "漢字ひらき"
): Record<string, unknown> {
  return { line: 1, original, target: original, suggestion, reason };
}

/** 1回ぶんの返り値。**Windows の区切りで渡す**（答えは `/` なので、揃うか見る） */
const RESULTS = [
  {
    chunkId: "本文\\001_あさ.txt#1-0@2000",
    accepted: [
      accepted("丁度そのとき", "ちょうどそのとき"),
      accepted("沢山あった", ""),
      accepted("然し彼は", "しかし彼は"),
      accepted("素敵な人", "すてきな人"),
      accepted("本を置く", "本をおく"),
      accepted("長い一文である", "短くした", "長文"),
    ],
    rejected: [
      { raw: {}, reason: "over_budget" },
      { raw: {}, reason: "over_budget" },
      { raw: {}, reason: "original_not_found" },
    ],
  },
];

const RUN = { results: RESULTS, failures: [], elapsedMs: 12_000 };

describe("推敲の答え合わせ", () => {
  it("当て字は、読みを含む修正案が出たものだけを拾ったと数える", () => {
    const scored = scoreProofread(ANSWERS, RESULTS);
    // 丁度＝拾った／沢山＝出たが提案なし
    expect(scored.ateji).toMatchObject({ found: 1, total: 2, noSuggestion: 1 });
  });

  it("ひらくべき語も同じ数え方（出なかった語は拾えていない）", () => {
    const scored = scoreProofread(ANSWERS, RESULTS);
    // 然し＝拾った／殆ど＝そもそも出ていない
    expect(scored.mustOpen).toMatchObject({ found: 1, total: 2 });
    expect(scored.mustOpen.byWord["殆ど"]).toMatchObject({ found: 0, total: 1 });
  });

  it("ひらいてはいけない語と本動詞は、ひらかれていたら誤検出に数える", () => {
    const scored = scoreProofread(ANSWERS, RESULTS);
    expect(scored.falsePositives.count).toBe(2);
    expect(scored.falsePositives.byWord).toEqual({ 素敵: 1, 置く: 1 });
  });

  it("修正案が空のものは、誤検出ではなく「提案なし」に数える", () => {
    // ひらいていないのだから「ひらいてはいけない語をひらいた」ではない
    const results = [
      {
        chunkId: "本文/001_あさ.txt#1-0@2000",
        accepted: [accepted("素敵な人", "")],
        rejected: [],
      },
    ];
    const scored = scoreProofread(ANSWERS, results);
    expect(scored.falsePositives.count).toBe(0);
    expect(countGeneric(results).noSuggestion).toBe(1);
  });

  it("「漢字ひらき」以外の札で語が消えても誤検出には数えない", () => {
    // 長文の書き直しでたまたま語が消えた回まで数えると、覚えの無い誤検出が積もる
    const results = [
      {
        chunkId: "本文/001_あさ.txt#1-0@2000",
        accepted: [accepted("素敵な人だった", "すてきな人だ", "長文")],
        rejected: [],
      },
    ];
    expect(scoreProofread(ANSWERS, results).falsePositives.count).toBe(0);
  });
});

/* ── 誤字脱字：正解が1つに決まらない仕込み ──────────────── */

describe("誤字脱字の答え合わせ（正解が複数ある仕込み）", () => {
  /*
    **打ちかけの字は、正解が1つに決まらない。**「ｓっと」は「すっと」でも
    「さっと」でも本文が正しくなる。台の README は「当てた結果で測る」と
    書いてあるのに、実装は鍵の文字列1つとの一致を見ていたので、
    **日本語として正しい直しを減点していた**（2026-09-19）。
  */
  const answers = {
    episodes: [
      {
        file: "本文/003_星待ちの夜.txt",
        seeded: [
          {
            kind: "打ちかけの字",
            wrong: "ｓっと",
            right: ["すっと", "さっと"],
            where: "律はｓっと立ち上がり",
          },
        ],
        mustNotFlag: [],
      },
    ],
  };
  const answerWith = (suggestion: string) => [
    {
      chunkId: "本文/003_星待ちの夜.txt#3-0@4013",
      accepted: [
        {
          line: 27,
          original: "律はｓっと立ち上がり",
          target: "ｓっと",
          suggestion,
          reason: "明らかな入力ミス",
        },
      ],
      rejected: [],
    },
  ];

  it.each(["すっと", "さっと"])(
    "どちらの直し方でも「拾えた」に数える（%s）",
    (suggestion) => {
      const scored = scoreTypo(answers, answerWith(suggestion));
      expect(scored.seeds).toMatchObject({ found: 1, total: 1 });
      expect(scored.wrongFix.count).toBe(0);
    }
  );

  it("当てても直らない直し方は、これまでどおり「直し方が違う」に数える", () => {
    // 広げたのは「正解が複数ある」だけで、**何でも通す**わけではない
    const scored = scoreTypo(answers, answerWith("ｓっと"));
    expect(scored.seeds).toMatchObject({ found: 0, total: 1 });
    expect(scored.wrongFix.count).toBe(1);
  });

  it("`right` が文字列1つの書き方も、これまでどおり動く", () => {
    const single = {
      episodes: [
        {
          ...answers.episodes[0],
          seeded: [{ ...answers.episodes[0].seeded[0], right: "すっと" }],
        },
      ],
    };
    expect(scoreTypo(single, answerWith("すっと")).seeds).toMatchObject({
      found: 1,
      total: 1,
    });
    expect(scoreTypo(single, answerWith("さっと")).wrongFix.count).toBe(1);
  });
});

/* ── 指摘の枠（上限）と、枠の抜け道 ──────────────────── */

/*
  **測り方の欠陥を、見えるようにするための数え方**（2026-09-18）。
  推敲は「字数/1000×3件」しか通さないので、**仕込みが上限を超えていれば
  どんなモデルでも満点は取れない**。また `original` に2語まとめて書くと
  1件の枠で2語ぶん当たるので、素直に1語1件で答えるモデルほど損をする。
*/
describe("指摘の上限（枠）", () => {
  const promptSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "prompts", "proofread.ts"),
    "utf8"
  );

  it("1000字あたりの上限は、製品の源から読む（写しを持たない）", () => {
    expect(maxIssuesPer1000CharsOf(promptSource)).toBe(
      MAX_ISSUES_PER_1000_CHARS
    );
  });

  it("上限が見つからなければ止める（古い上限のまま測らないように）", () => {
    expect(() => maxIssuesPer1000CharsOf("const なにもない = 1;")).toThrow(
      /MAX_ISSUES_PER_1000_CHARS/
    );
  });

  it("枠の式は、製品の issueBudget と同じ答えを返す", () => {
    // `.mjs` から `.ts` を import できないので式だけ写している。
    // **ずれていないことを、ここで製品と突き合わせる**
    for (const chars of [
      0, 1, 100, 499, 500, 999, 1000, 1400, 1464, 1478, 1500, 3000, 8000,
    ]) {
      expect(issueBudgetOf(chars, MAX_ISSUES_PER_1000_CHARS)).toBe(
        issueBudget(chars)
      );
    }
  });

  it("製品が渡した maxIssues があれば、それを合計する", () => {
    expect(
      budgetCeilingOf([{ maxIssues: 4 }, { maxIssues: 4 }, { maxIssues: 4 }], 3)
    ).toBe(12);
  });

  it("maxIssues が無ければ、字数から同じ式で出す", () => {
    // **1000字あたりの件数は引数で受ける**（製品の値を写さない）。ここは
    // 式だけを確かめるので、製品が上限を変えても落ちない
    expect(
      budgetCeilingOf([{ chars: 1464 }, { chars: 1478 }, { chars: 1402 }], 3)
    ).toBe(12);
  });

  it("字数も上限も分からなければ null（分からないものを 0 と出さない）", () => {
    expect(budgetCeilingOf([{ chunkId: "本文/001_あさ.txt" }], null)).toBeNull();
    expect(budgetCeilingOf([], MAX_ISSUES_PER_1000_CHARS)).toBeNull();
  });
});

describe("推敲の台（上限と仕込みの釣り合い）", () => {
  const root = path.join(__dirname, "..", "fixtures", "seeded", "proofread");
  const answers = JSON.parse(
    fs.readFileSync(path.join(root, "answers.json"), "utf8")
  );
  // この台は1話が1チャンクに収まる（`numCtx` 32,768 でおよそ8,000字）
  const plans = answers.episodes.map((episode: { file: string }) => ({
    chunkId: episode.file,
    chars: fs.readFileSync(path.join(root, episode.file), "utf8").length,
  }));

  it("仕込みの語数と上限を、どちらも数えられる", () => {
    // 台に仕込んである語（当て字8＋ひらくべき10）。**台を変えないかぎり動かない**
    expect(seededWordCount(answers)).toBe(18);
    // 上限は**製品の式そのまま**（この台は1話が1チャンクに収まる）
    expect(budgetCeilingOf(plans, MAX_ISSUES_PER_1000_CHARS)).toBe(
      plans.reduce(
        (sum: number, plan: { chars: number }) => sum + issueBudget(plan.chars),
        0
      )
    );
  });

  it("1000字あたり3件のころは12件で、18語には届かなかった", () => {
    // **この釣り合いが、この直しの発端である**（上限12件の台で12語当てた
    // モデルを「半分しか拾えない」と読み違えた）。製品の上限が上がれば
    // 天井も上がるが、**式と数え方が変わっていないこと**をここで留める
    expect(budgetCeilingOf(plans, 3)).toBe(12);
    expect(seededWordCount(answers)).toBeGreaterThan(12);
  });

  it("仕込みが上限を超えていれば、表に断りが出る", () => {
    const lines = formatSpreadLines(
      spreadOfRuns([
        { metrics: { budgetCeiling: 12, seededWords: 18, ateji: 7, atejiTotal: 8 } },
      ])
    );
    expect(lines[0]).toBe("指摘の上限: 12件（仕込みは18語）");
    expect(lines.some((line: string) => line.includes("満点は取れません"))).toBe(
      true
    );
    // 仕込みの語数は上限の行の中に出すので、単独の行にはしない
    expect(lines.some((line: string) => line.startsWith("仕込み（"))).toBe(false);
  });

  it("上限のほうが多ければ、断りは出ない", () => {
    const lines = formatSpreadLines(
      spreadOfRuns([{ metrics: { budgetCeiling: 30, seededWords: 18 } }])
    );
    expect(lines).toContain("指摘の上限: 30件（仕込みは18語）");
    expect(lines.some((line: string) => line.includes("満点は取れません"))).toBe(
      false
    );
  });

  it("上限を渡さなければ、上限の行は出ない（仕込みだけを出す）", () => {
    const { metrics } = metricsOfRun("proofread", ANSWERS, RUN);
    expect(metrics.budgetCeiling).toBeUndefined();
    expect(metrics.seededWords).toBe(4);
    const lines = formatSpreadLines(spreadOfRuns([{ metrics }]));
    expect(lines).toContain("仕込み（当て字＋ひらくべき語）: 4語");
  });
});

describe("1件に複数語を詰めた指摘", () => {
  it("答えの語を2つ含む指摘を1件と数える", () => {
    // 1件の枠で2語ぶん当たるので、素直に1語1件で答えるモデルほど損をする
    const results = [
      {
        chunkId: "本文/001_あさ.txt#1-0@2000",
        accepted: [accepted("然し丁度そのとき", "しかしちょうどそのとき")],
        rejected: [],
      },
    ];
    const packed = countPackedItems(ANSWERS, results);
    expect(packed.count).toBe(1);
    expect(packed.examples[0].words.sort()).toEqual(["丁度", "然し"]);
  });

  it("1語だけの指摘は数えない", () => {
    expect(countPackedItems(ANSWERS, RESULTS).count).toBe(0);
  });

  it("同じ語が2回出ても1語と数える（枠を回避できるのは別の語のときだけ）", () => {
    const results = [
      {
        chunkId: "本文/001_あさ.txt#1-0@2000",
        accepted: [accepted("丁度、丁度六時に", "ちょうど、ちょうど六時に")],
        rejected: [],
      },
    ];
    expect(countPackedItems(ANSWERS, results).count).toBe(0);
  });

  it("「漢字ひらき」以外の札は数えない（答え合わせがその札しか見ないため）", () => {
    const results = [
      {
        chunkId: "本文/001_あさ.txt#1-0@2000",
        accepted: [accepted("然し丁度そのとき", "しかし、ちょうど", "長文")],
        rejected: [],
      },
    ];
    expect(countPackedItems(ANSWERS, results).count).toBe(0);
  });

  it("表に出て、0件でなければ断りが添う", () => {
    const results = [
      {
        chunkId: "本文/001_あさ.txt#1-0@2000",
        accepted: [accepted("然し丁度そのとき", "しかしちょうどそのとき")],
        rejected: [],
      },
    ];
    const { metrics, detail } = metricsOfRun("proofread", ANSWERS, {
      results,
      failures: [],
      elapsedMs: 1_000,
    });
    expect(metrics.packedItems).toBe(1);
    // `detail` は機能ごとに中身が変わる袋なので、推敲のときだけ入る項目は `?.` で引く
    expect(detail.packedItems?.[0].original).toBe("然し丁度そのとき");
    const lines = formatSpreadLines(spreadOfRuns([{ metrics }]));
    expect(lines).toContain("1件に複数語を詰めた指摘: 1件");
    expect(
      lines.some((line: string) => line.includes("他のモデルと比べるときは注意"))
    ).toBe(true);
  });

  it("0件なら断りは添わない", () => {
    const { metrics } = metricsOfRun("proofread", ANSWERS, RUN);
    expect(metrics.packedItems).toBe(0);
    const lines = formatSpreadLines(spreadOfRuns([{ metrics }]));
    expect(lines).toContain("1件に複数語を詰めた指摘: 0件");
    expect(
      lines.some((line: string) => line.includes("他のモデルと比べるときは注意"))
    ).toBe(false);
  });

  it("推敲以外の機能には、上限も詰め込みも出ない", () => {
    const { metrics } = metricsOfRun("typo", null, RUN);
    expect(metrics.budgetCeiling).toBeUndefined();
    expect(metrics.seededWords).toBeUndefined();
    expect(metrics.packedItems).toBeUndefined();
  });
});

/* ── 逸脱（P-11）─────────────────────────────────────── */

/** 答え（`test/fixtures/seeded/deviation/answers.json` の形を小さく写したもの） */
const DEVIATION_ANSWERS = {
  mustNotFlag: ["本文/001_灯が消えた朝.txt"],
  episodes: [
    { file: "本文/001_灯が消えた朝.txt", seeded: [] },
    {
      file: "本文/002_灯台へ.txt",
      seeded: [
        {
          kind: "逸脱",
          where: "文化祭、出ないか。あと三人いる",
          lines: { start: 1, end: 45 },
        },
      ],
    },
    {
      file: "本文/004_もう一度、灯をともす.txt",
      seeded: [
        {
          kind: "間延び",
          where: "本当に点くのかな",
          lines: { start: 11, end: 43 },
        },
      ],
    },
  ],
};

/** 1件の指摘（`core/deviationValidation.ts` の `AcceptedDeviation` の形） */
function deviation(
  excerpt: string,
  type = "逸脱",
  lineStart = 1,
  lineEnd = 1
): Record<string, unknown> {
  return {
    lineStart,
    lineEnd,
    excerpt,
    type,
    reason: "プロットに無い展開",
    plotReference: "第2話　灯台へ",
    severity: "medium",
    confidence: "high",
  };
}

describe("逸脱の答え合わせ", () => {
  it("引用が重なれば拾えたと数える（鉤括弧の有無は問わない）", () => {
    const results = [
      {
        chunkId: "本文\\002_灯台へ.txt",
        accepted: [deviation("「文化祭、出ないか。あと三人いる」", "逸脱", 7, 45)],
        rejected: [],
      },
    ];
    const scored = scoreDeviation(DEVIATION_ANSWERS, results);
    expect(scored.seeds).toMatchObject({ found: 1, total: 2 });
    expect(scored.seeds.byKind["逸脱"]).toEqual({ found: 1, total: 1 });
    expect(scored.missed).toHaveLength(1);
    expect(scored.missed[0].kind).toBe("間延び");
  });

  it("引用がずれていても、行の範囲が重なれば拾えたと数える", () => {
    // AIは引用を言い換えることがある。場所が合っているなら当てている
    const results = [
      {
        chunkId: "本文/002_灯台へ.txt",
        accepted: [deviation("宮下がスティックで数を取り", "逸脱", 27, 31)],
        rejected: [],
      },
    ];
    expect(scoreDeviation(DEVIATION_ANSWERS, results).seeds.found).toBe(1);
  });

  it("場所も行も外していれば見逃し", () => {
    const results = [
      {
        chunkId: "本文/002_灯台へ.txt",
        accepted: [deviation("灯台のことなら、町はずれの爺さんに聞け", "逸脱", 55, 55)],
        rejected: [],
      },
    ];
    const scored = scoreDeviation(DEVIATION_ANSWERS, results);
    expect(scored.seeds.found).toBe(0);
    // 仕込みに当たらなかった指摘は、誤検出ではなく「仕込み以外」に数える
    expect(scored.falsePositives.count).toBe(0);
    expect(scored.otherFlags).toBe(1);
  });

  it("プロットどおりの話に付いた指摘は、すべて誤検出", () => {
    const results = [
      {
        chunkId: "本文/001_灯が消えた朝.txt",
        accepted: [deviation("母は答えなかった", "逸脱", 19, 19), deviation("行ってきます")],
        rejected: [],
      },
    ];
    const scored = scoreDeviation(DEVIATION_ANSWERS, results);
    expect(scored.falsePositives.count).toBe(2);
    expect(scored.falsePositives.byFile["本文/001_灯が消えた朝.txt"]).toBe(2);
  });

  it("同じ指摘を2つの仕込みに使い回さない", () => {
    // 1件しか出していないのに満点になってはいけない
    const answers = {
      mustNotFlag: [],
      episodes: [
        {
          file: "本文/004_もう一度、灯をともす.txt",
          seeded: [
            { kind: "間延び", where: "本当に点くのかな", lines: { start: 11, end: 43 } },
            { kind: "逸脱", where: "六十二段ある。数えて上れ", lines: { start: 11, end: 43 } },
          ],
        },
      ],
    };
    const results = [
      {
        chunkId: "本文/004_もう一度、灯をともす.txt",
        accepted: [deviation("本当に点くのかな", "間延び", 13, 35)],
        rejected: [],
      },
    ];
    const scored = scoreDeviation(answers, results);
    expect(scored.seeds).toMatchObject({ found: 1, total: 2 });
  });

  it("場所は当てて種別を取り違えたものは、拾えたに数えたうえで別に出す", () => {
    const results = [
      {
        chunkId: "本文/004_もう一度、灯をともす.txt",
        accepted: [deviation("本当に点くのかな", "逸脱", 13, 35)],
        rejected: [],
      },
    ];
    const scored = scoreDeviation(DEVIATION_ANSWERS, results);
    expect(scored.seeds.found).toBe(1);
    expect(scored.kindMismatch).toBe(1);
  });

  it("短すぎる引用は、偶然重なっても拾えたと数えない", () => {
    const results = [
      {
        chunkId: "本文/002_灯台へ.txt",
        accepted: [deviation("文化", "逸脱", 60, 60)],
        rejected: [],
      },
    ];
    expect(scoreDeviation(DEVIATION_ANSWERS, results).seeds.found).toBe(0);
  });

  it("指標の表に、拾えた・見逃し・誤検出が並ぶ", () => {
    const results = [
      {
        chunkId: "本文/002_灯台へ.txt",
        accepted: [deviation("文化祭、出ないか。あと三人いる", "逸脱", 7, 45)],
        rejected: [{ raw: {}, reason: "plot_reference_not_found" }],
      },
      {
        chunkId: "本文/001_灯が消えた朝.txt",
        accepted: [deviation("行ってきます")],
        rejected: [],
      },
    ];
    const { metrics } = metricsOfRun("deviation", DEVIATION_ANSWERS, {
      results,
      failures: [],
      elapsedMs: 40_000,
    });
    expect(metrics).toMatchObject({
      seeded: 1,
      seededTotal: 2,
      missed: 1,
      falseFlags: 1,
      kindMismatch: 0,
      otherFlags: 0,
      accepted: 2,
      "rejected.plot_reference_not_found": 1,
    });
    const lines = formatSpreadLines(spreadOfRuns([{ metrics }]));
    expect(lines).toContain("仕込んだ逸脱を拾えた: 1/2");
    expect(lines).toContain("見逃し（拾えなかった仕込み）: 1");
    expect(lines).toContain("誤検出（プロットどおりの話に付いた指摘）: 1");
  });

  it("推敲の見出しが、逸脱の表へ漏れない", () => {
    // 「提案なし（漢字ひらきなのに修正案が空）」は推敲だけの指標である
    const { metrics } = metricsOfRun("deviation", DEVIATION_ANSWERS, {
      results: [],
      failures: [],
      elapsedMs: 1,
    });
    expect(metrics.noSuggestion).toBeUndefined();
    const lines = formatSpreadLines(spreadOfRuns([{ metrics }]));
    expect(lines.some((line: string) => line.includes("漢字ひらき"))).toBe(false);
  });
});

describe("返り値の形（話まるごとを1回で見る道具）", () => {
  it("`result` を1つ返す道具は、呼んだファイル名を chunkId にして拾う", () => {
    // 逸脱・各話あらすじは `runOnce` を通るので `results[]` を返さない。
    // ここを拾えていなかったので、何件出ても0件として記録されていた
    const response = {
      runner: "ollama",
      model: "gemma4:26b",
      result: { accepted: [deviation("文化祭、出ないか。あと三人いる")], rejected: [] },
      plotTrimmed: false,
    };
    const items = resultsOfResponse(response, "本文\\002_灯台へ.txt");
    expect(items).toHaveLength(1);
    expect(items[0].chunkId).toBe("本文\\002_灯台へ.txt");
    expect(items[0].accepted).toHaveLength(1);
  });

  it("`results[]` を返す道具はそのまま", () => {
    expect(resultsOfResponse({ results: RESULTS }, "むし")).toBe(RESULTS);
  });

  it("どちらも無ければ空", () => {
    expect(resultsOfResponse({ runner: "claude" }, "むし")).toEqual([]);
  });
});

describe("逸脱の測定台（答えと本文が食い違っていないか）", () => {
  const root = path.join(
    __dirname,
    "..",
    "fixtures",
    "seeded",
    "deviation"
  );
  const answers = JSON.parse(
    fs.readFileSync(path.join(root, "answers.json"), "utf8")
  );

  it("仕込みの引用は、その話の本文にそのまま実在する", () => {
    // 実在しない引用を答えにすると、拾えたかどうかを永久に判定できない
    for (const episode of answers.episodes) {
      const text = fs.readFileSync(path.join(root, episode.file), "utf8");
      for (const seed of episode.seeded) {
        expect(text).toContain(seed.where);
      }
    }
  });

  it("仕込みの行の範囲は、その話の行数に収まっている", () => {
    for (const episode of answers.episodes) {
      const text = fs.readFileSync(path.join(root, episode.file), "utf8");
      const lastLine = text.split("\n").length;
      for (const seed of episode.seeded) {
        expect(seed.lines.start).toBeGreaterThanOrEqual(1);
        expect(seed.lines.end).toBeLessThanOrEqual(lastLine);
      }
    }
  });

  it("種別は、プロンプトが使う語だけ（逸脱・間延び）", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "prompts", "deviationCheck.ts"),
      "utf8"
    );
    const declared = source
      .match(/DEVIATION_TYPES = \[([^\]]+)\]/)?.[1]
      .match(/"([^"]+)"/g)
      ?.map((quoted: string) => quoted.replace(/"/g, ""));
    expect(declared).toBeTruthy();
    for (const episode of answers.episodes) {
      for (const seed of episode.seeded) {
        expect(declared).toContain(seed.kind);
      }
    }
  });

  it("1話につき仕込みは1つだけ（deviationBudget が1件しか通さないため）", () => {
    for (const episode of answers.episodes) {
      expect(episode.seeded.length).toBeLessThanOrEqual(1);
    }
  });

  it("上限と仕込みが釣り合っている（推敲の台と違い、ちょうど）", () => {
    // 推敲の台は上限12件に18語を仕込んであり満点が取れない。**ここは同じ形の
    // 欠陥が無いことを確かめる**——1話1件の枠に、仕込みも1話1つ
    let ceiling = 0;
    let seeded = 0;
    for (const episode of answers.episodes) {
      const text = fs.readFileSync(path.join(root, episode.file), "utf8");
      ceiling += deviationBudget(text.length);
      seeded += episode.seeded.length;
      expect(episode.seeded.length).toBeLessThanOrEqual(
        deviationBudget(text.length)
      );
    }
    expect(seeded).toBe(3);
    expect(ceiling).toBe(4); // 4話ぶん（仕込みの無い第1話にも枠が1つある）
  });

  it("指摘が出てはいけない話には、仕込みが無い", () => {
    for (const file of answers.mustNotFlag) {
      const episode = answers.episodes.find(
        (item: { file: string }) => item.file === file
      );
      expect(episode).toBeTruthy();
      expect(episode.seeded).toHaveLength(0);
    }
  });
});

/* ── 矛盾（P-12）─────────────────────────────────────── */

/** 答え（`test/fixtures/seeded/contradiction/answers.json` の形を小さく写したもの） */
const CONTRADICTION_ANSWERS = {
  mustNotFlag: [
    // `where` が無い＝その話まるごと
    { file: "本文/001_九月の終わりの坂.txt" },
    // `where` がある＝その箇所だけ（罠）
    {
      file: "本文/004_ギプスが外れた日.txt",
      where: "今日から乗る",
      lines: { start: 12, end: 18 },
    },
  ],
  episodes: [
    { file: "本文/001_九月の終わりの坂.txt", seeded: [] },
    {
      file: "本文/003_窓口の椅子.txt",
      seeded: [
        {
          kind: "人物",
          where: "僕は判子を押す手を止めた",
          lines: { start: 39, end: 39 },
        },
      ],
    },
    {
      file: "本文/004_ギプスが外れた日.txt",
      seeded: [
        {
          kind: "状態",
          where: "右足のギプスが外れたのは",
          lines: { start: 1, end: 1 },
        },
      ],
    },
  ],
};

/** 1件の指摘（`core/contradictionValidation.ts` の `AcceptedContradiction` の形） */
function contradiction(
  excerpt: string,
  category = "人物",
  line = 1
): Record<string, unknown> {
  return {
    line,
    excerpt,
    category,
    settingSays: "設定ではこうなっている",
    textSays: "本文ではこうなっている",
    note: "",
    severity: "medium",
    confidence: "high",
  };
}

describe("矛盾の答え合わせ", () => {
  it("引用が重なれば拾えたと数える（鉤括弧の有無は問わない）", () => {
    const results = [
      {
        chunkId: "本文\\003_窓口の椅子.txt#3-0@8027",
        accepted: [contradiction("「僕は判子を押す手を止めた」", "人物", 39)],
        rejected: [],
      },
    ];
    const scored = scoreContradiction(CONTRADICTION_ANSWERS, results);
    expect(scored.seeds).toMatchObject({ found: 1, total: 2 });
    expect(scored.seeds.byKind["人物"]).toEqual({ found: 1, total: 1 });
    expect(scored.missed).toHaveLength(1);
    expect(scored.missed[0].kind).toBe("状態");
  });

  it("引用がずれていても、行が仕込みの範囲に入れば拾えたと数える", () => {
    // 矛盾の指摘は `line` を1つしか持たない。点が範囲に入るかで見る
    const results = [
      {
        chunkId: "本文/003_窓口の椅子.txt#3-0@8027",
        accepted: [contradiction("一人称が食い違っている", "人物", 39)],
        rejected: [],
      },
    ];
    expect(scoreContradiction(CONTRADICTION_ANSWERS, results).seeds.found).toBe(1);
  });

  it("場所も行も外していれば見逃し（誤検出ではなく仕込み以外）", () => {
    const results = [
      {
        chunkId: "本文/003_窓口の椅子.txt#3-0@8027",
        accepted: [contradiction("栗だ。丘のは町のより甘い", "人物", 44)],
        rejected: [],
      },
    ];
    const scored = scoreContradiction(CONTRADICTION_ANSWERS, results);
    expect(scored.seeds.found).toBe(0);
    expect(scored.falsePositives.count).toBe(0);
    expect(scored.otherFlags).toBe(1);
  });

  it("矛盾の無い話に付いた指摘は、すべて誤検出", () => {
    const results = [
      {
        chunkId: "本文/001_九月の終わりの坂.txt#1-0@8027",
        accepted: [
          contradiction("俺は右目の下を手の甲でこすった", "人物", 23),
          contradiction("四十分。いつもそれくらいかかる", "時系列", 3),
        ],
        rejected: [],
      },
    ];
    const scored = scoreContradiction(CONTRADICTION_ANSWERS, results);
    expect(scored.falsePositives.count).toBe(2);
    expect(scored.falsePositives.byFile["本文/001_九月の終わりの坂.txt"]).toBe(2);
    expect(scored.otherFlags).toBe(0);
  });

  it("罠（変わってよい箇所）に付いた指摘は誤検出、同じ話の仕込みは拾えたまま", () => {
    // 1つの話に仕込みと罠が同居する。片方だけを数えてはいけない
    const results = [
      {
        chunkId: "本文/004_ギプスが外れた日.txt#4-0@8027",
        accepted: [
          contradiction("右足のギプスが外れたのは", "状態", 1),
          contradiction("今日から乗る", "状態", 14),
        ],
        rejected: [],
      },
    ];
    const scored = scoreContradiction(CONTRADICTION_ANSWERS, results);
    expect(scored.seeds.found).toBe(1);
    expect(scored.falsePositives.count).toBe(1);
    expect(scored.falsePositives.byFile["本文/004_ギプスが外れた日.txt"]).toBe(1);
    expect(scored.otherFlags).toBe(0);
  });

  it("同じ指摘を2つの仕込みに使い回さない", () => {
    const answers = {
      mustNotFlag: [],
      episodes: [
        {
          file: "本文/005_初雪の窓口.txt",
          seeded: [
            { kind: "人物", where: "左目の下のほくろ", lines: { start: 7, end: 11 } },
            { kind: "時系列", where: "ちょうど二週間が過ぎた", lines: { start: 7, end: 11 } },
          ],
        },
      ],
    };
    const results = [
      {
        chunkId: "本文/005_初雪の窓口.txt#5-0@8027",
        accepted: [contradiction("左目の下のほくろ", "人物", 7)],
        rejected: [],
      },
    ];
    expect(scoreContradiction(answers, results).seeds).toMatchObject({
      found: 1,
      total: 2,
    });
  });

  it("場所は当てて区分を取り違えたものは、拾えたに数えたうえで別に出す", () => {
    const results = [
      {
        chunkId: "本文/004_ギプスが外れた日.txt#4-0@8027",
        accepted: [contradiction("右足のギプスが外れたのは", "時系列", 1)],
        rejected: [],
      },
    ];
    const scored = scoreContradiction(CONTRADICTION_ANSWERS, results);
    expect(scored.seeds.found).toBe(1);
    expect(scored.kindMismatch).toBe(1);
  });

  it("短すぎる引用は、偶然重なっても拾えたと数えない", () => {
    const results = [
      {
        chunkId: "本文/003_窓口の椅子.txt#3-0@8027",
        accepted: [contradiction("判子", "人物", 55)],
        rejected: [],
      },
    ];
    expect(scoreContradiction(CONTRADICTION_ANSWERS, results).seeds.found).toBe(0);
  });

  it("指標の表に、拾えた・見逃し・誤検出が並ぶ（逸脱の見出しと混ざらない）", () => {
    const results = [
      {
        chunkId: "本文/003_窓口の椅子.txt#3-0@8027",
        accepted: [contradiction("僕は判子を押す手を止めた", "人物", 39)],
        rejected: [{ raw: {}, reason: "excerpt_not_found" }],
      },
      {
        chunkId: "本文/001_九月の終わりの坂.txt#1-0@8027",
        accepted: [contradiction("俺は右目の下を手の甲でこすった", "人物", 23)],
        rejected: [],
      },
    ];
    const { metrics } = metricsOfRun("contradiction", CONTRADICTION_ANSWERS, {
      results,
      failures: [],
      elapsedMs: 60_000,
    });
    expect(metrics).toMatchObject({
      seededContradictions: 1,
      seededContradictionsTotal: 2,
      missedContradictions: 1,
      falseFlagsContradiction: 1,
      categoryMismatch: 0,
      otherFlagsContradiction: 0,
      accepted: 2,
      "rejected.excerpt_not_found": 1,
    });
    const lines = formatSpreadLines(spreadOfRuns([{ metrics }]));
    expect(lines).toContain("仕込んだ矛盾を拾えた: 1/2");
    expect(lines).toContain("見逃し（拾えなかった仕込み）: 1");
    expect(lines).toContain("誤検出（罠と、矛盾の無い話に付いた指摘）: 1");
    // 逸脱の見出しが混ざらない（指標の名前を分けてある理由）
    expect(lines.some((line: string) => line.includes("逸脱"))).toBe(false);
    expect(metrics.noSuggestion).toBeUndefined();
  });
});

describe("矛盾の測定台（答えと本文が食い違っていないか）", () => {
  const root = path.join(__dirname, "..", "fixtures", "seeded", "contradiction");
  const answers = JSON.parse(
    fs.readFileSync(path.join(root, "answers.json"), "utf8")
  );
  const bodyOf = (file: string) =>
    fs.readFileSync(path.join(root, file), "utf8");

  it("仕込みの引用は、その話の本文にそのまま実在する", () => {
    for (const episode of answers.episodes) {
      const text = bodyOf(episode.file);
      for (const seed of episode.seeded) expect(text).toContain(seed.where);
    }
  });

  it("罠の引用も、その話の本文にそのまま実在する", () => {
    for (const entry of answers.mustNotFlag) {
      if (!entry.where) continue;
      expect(bodyOf(entry.file)).toContain(entry.where);
    }
  });

  it("仕込みと罠の行の範囲は、その話の行数に収まっている", () => {
    const ranges: Array<{ file: string; lines: { start: number; end: number } }> =
      [];
    for (const episode of answers.episodes) {
      for (const seed of episode.seeded) {
        ranges.push({ file: episode.file, lines: seed.lines });
      }
    }
    for (const entry of answers.mustNotFlag) {
      if (entry.lines) ranges.push({ file: entry.file, lines: entry.lines });
    }
    for (const range of ranges) {
      const lastLine = bodyOf(range.file).split("\n").length;
      expect(range.lines.start).toBeGreaterThanOrEqual(1);
      expect(range.lines.end).toBeLessThanOrEqual(lastLine);
      expect(range.lines.end).toBeGreaterThanOrEqual(range.lines.start);
    }
  });

  it("区分は、light の観点の語だけ（人物・状態・時系列）", () => {
    // **all でしか見ない観点を混ぜない。** 混ぜると light で測ったときに
    // 「観点の外だから出なかったもの」が見逃しとして積まれる
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "prompts", "contradictionCheck.ts"),
      "utf8"
    );
    const light = source
      .match(/LIGHT_CATEGORIES[^=]*=\s*\[([^\]]+)\]/)?.[1]
      .match(/"([^"]+)"/g)
      ?.map((quoted: string) => quoted.replace(/"/g, ""));
    expect(light).toEqual(["人物", "状態", "時系列"]);
    for (const episode of answers.episodes) {
      for (const seed of episode.seeded) expect(light).toContain(seed.kind);
    }
    for (const entry of answers.mustNotFlag) {
      if (entry.kind) expect(light).toContain(entry.kind);
    }
  });

  it("話まるごとの mustNotFlag には、仕込みが無い", () => {
    for (const entry of answers.mustNotFlag) {
      if (entry.where) continue;
      const episode = answers.episodes.find(
        (item: { file: string }) => item.file === entry.file
      );
      expect(episode).toBeTruthy();
      expect(episode.seeded).toHaveLength(0);
    }
  });

  it("仕込みと罠の行の範囲は、同じ話の中で重なっていない", () => {
    // 重なると、どちらに当たった指摘なのかを機械が決められない
    for (const episode of answers.episodes) {
      const traps = answers.mustNotFlag.filter(
        (entry: { file: string; where?: string }) =>
          entry.file === episode.file && entry.where
      );
      for (const seed of episode.seeded) {
        for (const trap of traps) {
          const apart =
            seed.lines.end < trap.lines.start || seed.lines.start > trap.lines.end;
          expect(apart).toBe(true);
        }
      }
    }
  });

  it("どの話も各話あらすじに載っている（載っていないと材料が渡らない）", () => {
    const synopses = JSON.parse(
      fs.readFileSync(
        path.join(root, "設定", "chapter_synopses.json"),
        "utf8"
      )
    );
    const chapters = new Set(
      synopses.episodes.map((item: { chapter: number }) => item.chapter)
    );
    for (const episode of answers.episodes) {
      expect(chapters.has(episode.chapter)).toBe(true);
    }
  });

  it("各話は 1,200〜1,500字に収まっている", () => {
    for (const episode of answers.episodes) {
      const chars = bodyOf(episode.file).length;
      expect(chars).toBeGreaterThanOrEqual(1200);
      expect(chars).toBeLessThanOrEqual(1500);
    }
  });
});

describe("落とした理由と失敗", () => {
  it("理由ごとに数える", () => {
    expect(countGeneric(RESULTS).rejectedReasons).toEqual({
      over_budget: 2,
      original_not_found: 1,
    });
  });

  it("指標の表に、答え合わせと内訳と失敗と所要時間が並ぶ", () => {
    const { metrics } = metricsOfRun("proofread", ANSWERS, RUN);
    expect(metrics).toMatchObject({
      ateji: 1,
      atejiTotal: 2,
      mustOpen: 1,
      mustOpenTotal: 2,
      falsePositives: 2,
      noSuggestion: 1,
      accepted: 6,
      rejected: 3,
      "rejected.over_budget": 2,
      "rejected.original_not_found": 1,
      failures: 0,
      elapsedMs: 12_000,
    });
  });

  it("答えの無い機能は、件数と理由だけを数える（見逃しは数えない）", () => {
    const { metrics } = metricsOfRun("typo", null, RUN);
    expect(metrics.ateji).toBeUndefined();
    expect(metrics.accepted).toBe(6);
  });

  it("失敗は件数と理由をそのまま残す", () => {
    const { metrics, detail } = metricsOfRun("proofread", ANSWERS, {
      results: [],
      failures: [{ chunkId: "本文/001_あさ.txt#1-0@2000", reason: "模型が落ちた" }],
      elapsedMs: 100,
    });
    expect(metrics.failures).toBe(1);
    expect(detail.failures[0].reason).toBe("模型が落ちた");
  });
});

describe("揺れ幅", () => {
  const runs = [
    { metrics: { ateji: 3, atejiTotal: 8, "rejected.over_budget": 1 } },
    { metrics: { ateji: 5, atejiTotal: 8 } },
    { metrics: { ateji: 4, atejiTotal: 8 } },
  ];

  it("3回分の最小〜最大が出る", () => {
    const spread = spreadOfRuns(runs);
    expect(spread.ateji).toEqual({ values: [3, 5, 4], min: 3, max: 5 });
  });

  it("ある回に出なかった指標は 0 として数える", () => {
    // 1回だけ出た `over_budget` は「1〜1」ではなく「0〜1」が本当のところ
    expect(spreadOfRuns(runs)["rejected.over_budget"]).toEqual({
      values: [1, 0, 0],
      min: 0,
      max: 1,
    });
  });

  it("画面には、指標ごとに1行ずつ日本語で出る", () => {
    const lines = formatSpreadLines(spreadOfRuns(runs));
    expect(lines[0]).toBe("当て字を拾えた: 3/8〜5/8（各回：3/8、5/8、4/8）");
    // 分母そのものは行にしない
    expect(lines.some((line: string) => line.includes("atejiTotal"))).toBe(false);
  });

  it("1回だけなら、揺れ幅ではなくその値を出す", () => {
    const lines = formatSpreadLines(spreadOfRuns([{ metrics: { ateji: 3, atejiTotal: 8 } }]));
    expect(lines[0]).toBe("当て字を拾えた: 3/8");
  });
});

describe("前回との比較（--compare）", () => {
  it("「前 → 後」で並ぶ", () => {
    const before = spreadOfRuns([{ metrics: { ateji: 3, atejiTotal: 8, accepted: 10 } }]);
    const after = spreadOfRuns([{ metrics: { ateji: 5, atejiTotal: 8, accepted: 12 } }]);
    const lines = formatCompareLines(before, after);
    expect(lines).toContain("当て字を拾えた: 3/8 → 5/8");
    expect(lines).toContain("指摘（検算を通ったもの）: 10 → 12");
  });

  it("片方にしか無い指標も、0 として出す", () => {
    // 消えたことは、消えたと書かないと伝わらない
    const before = spreadOfRuns([{ metrics: { "rejected.original_not_found": 4 } }]);
    const after = spreadOfRuns([{ metrics: { accepted: 1 } }]);
    expect(formatCompareLines(before, after)).toContain(
      "　└ 落とした理由：original_not_found: 4 → 0"
    );
  });
});

describe("道具名の対応表", () => {
  const serverSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "mcp", "server.ts"),
    "utf8"
  );

  it("台本が呼ぶ道具は、すべて server.ts に登録されている", () => {
    const registered = registeredToolNames(serverSource);
    for (const name of [RUN_TOOL, PROMPT_TOOL]) {
      expect(registered).toContain(name);
    }
    // **束ねたので、どの feature も同じ道具へ行く**（0.66.7）
    for (const feature of FEATURES) {
      expect(toolNameOf(feature)).toBe(RUN_TOOL);
    }
  });

  it("登録されていない名前は止める", () => {
    expect(() => assertToolRegistered(serverSource, "nothing.run")).toThrow();
  });

  it("知らない feature は、選べるものを並べて断る", () => {
    expect(() => toolNameOf("むかしばなし")).toThrow(/proofread/);
  });

  it("矛盾の2つの道は、**同じ答え付きの台**で測る", () => {
    /*
      台を分けると、点差が「道の違い」なのか「台の違い」なのかが読めなくなる
      ——並べて読むためにここを共有している（設計書6.88.10 の第5段）。
    */
    expect(fixtureDirOf("contradiction")).toBe("contradiction");
    expect(fixtureDirOf("factContradiction")).toBe("contradiction");
    // ほかの feature は、これまでどおり自分の名前のフォルダー
    expect(fixtureDirOf("proofread")).toBe("proofread");
    for (const feature of CONTRADICTION_FEATURES) {
      expect(FEATURES).toContain(feature);
    }
  });

  it("事実の照合も、同じ数え方で採点される", () => {
    // **`contradiction` にしか効かない書き方をしていないか**を見る
    const answers = {
      mustNotFlag: [],
      episodes: [
        {
          file: "本文/004.txt",
          seeded: [{ kind: "状態", where: "右足のギプスが外れたのは" }],
        },
      ],
    };
    const results = [
      {
        // 事実の照合はファイルごとにまとめて返す（`chunkId` にファイルを置く）
        chunkId: "本文\\004.txt",
        accepted: [
          {
            line: 1,
            excerpt: "右足のギプスが外れたのは",
            category: "状態",
          },
        ],
        rejected: [],
      },
    ];
    const scored = metricsOfRun("factContradiction", answers, { results });
    expect(scored.metrics.seededContradictions).toBe(1);
    expect(scored.metrics.missedContradictions).toBe(0);
    expect(scored.metrics.falseFlagsContradiction).toBe(0);
  });

  it("プロンプト版を訊く道具の名前も、登録名と合う", () => {
    const registered = registeredToolNames(serverSource);
    expect(promptToolOf(RUN_TOOL)).toBe(PROMPT_TOOL);
    expect(registered).toContain(promptToolOf(RUN_TOOL));
    // 知らない道具には、訊く先が無い
    expect(promptToolOf("ollama.models")).toBe(null);
  });
});

describe("結果の置き場所", () => {
  it("モデル名の `:` と `/` は `_` にする", () => {
    expect(measurementFileName("2026-09-18", "proofread", "gemma4:12b")).toBe(
      "2026-09-18-proofread-gemma4_12b.json"
    );
  });

  it("同名があれば -2、-3 と増やす（上書きしない）", () => {
    const taken = new Set(["a.json", "a-2.json"]);
    expect(pickFreeName("a.json", (name: string) => taken.has(name))).toBe("a-3.json");
  });
});
