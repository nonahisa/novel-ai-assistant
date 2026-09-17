import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FEATURE_TOOLS,
  assertToolRegistered,
  countGeneric,
  formatCompareLines,
  formatSpreadLines,
  measurementFileName,
  metricsOfRun,
  pickFreeName,
  promptToolOf,
  registeredToolNames,
  resultsOfResponse,
  scoreDeviation,
  scoreProofread,
  spreadOfRuns,
  toolNameOf,
} from "../../scripts/measureScoring.mjs";

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

  it("表に書いた道具は、すべて server.ts に登録されている", () => {
    const registered = registeredToolNames(serverSource);
    for (const name of Object.values(FEATURE_TOOLS)) {
      expect(registered).toContain(name);
    }
  });

  it("登録されていない名前は止める", () => {
    expect(() => assertToolRegistered(serverSource, "nothing.run")).toThrow();
  });

  it("知らない feature は、選べるものを並べて断る", () => {
    expect(() => toolNameOf("むかしばなし")).toThrow(/proofread/);
  });

  it("プロンプト版を訊く道具の名前も、登録名と合う", () => {
    const registered = registeredToolNames(serverSource);
    expect(promptToolOf("proofread.run")).toBe("proofread.prompt");
    expect(promptToolOf("episode.deviationRun")).toBe("episode.deviationPrompt");
    expect(registered).toContain(promptToolOf("episode.deviationRun"));
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
