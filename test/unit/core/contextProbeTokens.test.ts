import { describe, expect, test } from "vitest";
import {
  PROBE_MAX_TOKENS_PER_CHAR,
  buildProbePrompt,
  charsPerTokenFromProbe,
  describeProbeResult,
  judgeProbeGrowth,
  nextProbeSize,
  probeOverheadChars,
  readProbeTokens,
  startProbeState,
  type ProbeState,
  type ProbeTokenReading,
} from "../../../src/core/contextProbe";

/**
 * 「読める長さ」を**入力トークン数の伸び**で測る（作者の裁定、2026-09-13。
 * 設計書6.27.11）。
 *
 * 合言葉で測っていた頃、実機（qwen3:8b）では長さと関係なく気まぐれに
 * 落ちていた——2,750字で通り、4,000字で落ち、8,000字と16,000字で通り、
 * 30,000字で落ちた。**落ちた回も本文は全部届いていた**（入力トークンは
 * 3,385・24,447）。合言葉は「届いたか」ではなく「言うことを聞くか」を
 * 測っていた。
 *
 * この検査は、その実機の数字をそのまま土台に置いてある。**同じ数字で
 * 同じ判定が出なくなったら、直したはずのものが戻っている。**
 */

/** 実機の6件（送った詰め物の字数 → 応答が申告した入力トークン数） */
const 実機の測定: readonly (readonly [number, number])[] = [
  [1_000, 953],
  [2_750, 2_373],
  [4_000, 3_385],
  [8_000, 6_621],
  [16_000, 13_103],
  [30_000, 24_447],
];

/** 詰め物の字数を、実際に送るプロンプト全体の字数へ直す */
function 送る字数(fillerChars: number): number {
  return fillerChars + probeOverheadChars();
}

function reading(fillerChars: number, inputTokens: number): ProbeTokenReading {
  return { promptChars: 送る字数(fillerChars), inputTokens };
}

describe("実機の6件を、そのまま流す", () => {
  test("どの回も「伸びた」と判定される（合言葉が落ちた回を含む）", () => {
    const readings: ProbeTokenReading[] = [];
    for (const [chars, tokens] of 実機の測定) {
      const next = reading(chars, tokens);
      const growth = judgeProbeGrowth(next, readings);
      expect(growth.grew, `${chars}字 → ${tokens}トークン`).toBe(true);
      readings.push(next);
    }
  });

  test("4,000字と30,000字——合言葉が落ちた2回も、届いていたと読む", () => {
    // ここが、この作り直しの要である。合言葉だけで測っていた頃は、
    // この2回で探索が下へ降りて、1,750字・2,750字・76,815字とばらついた
    const readings = 実機の測定
      .filter(([chars]) => chars < 4_000)
      .map(([chars, tokens]) => reading(chars, tokens));
    expect(judgeProbeGrowth(reading(4_000, 3_385), readings).grew).toBe(true);

    const 三万まで = 実機の測定
      .filter(([chars]) => chars < 30_000)
      .map(([chars, tokens]) => reading(chars, tokens));
    expect(judgeProbeGrowth(reading(30_000, 24_447), 三万まで).grew).toBe(true);
  });

  test("伸びが止まったら、そこが限界", () => {
    // 30,000字で 24,447、60,000字でも 24,600——倍にしても 153 しか
    // 増えていない。これが「増えなくなった」である
    const readings = 実機の測定.map(([chars, tokens]) => reading(chars, tokens));
    const growth = judgeProbeGrowth(reading(60_000, 24_600), readings);
    expect(growth.grew).toBe(false);
    // なぜそう判定したかを、ログで読めるようにしておく
    expect(growth.note).toContain("153");
  });

  test("傾きから、そのモデルの字/トークンが出る", () => {
    // 送った字数 ÷ 増えた入力トークン数。**1回の測定で2つ取れる**
    const readings = 実機の測定.map(([chars, tokens]) => reading(chars, tokens));
    const value = charsPerTokenFromProbe(readings);
    // (30,000 - 1,000) ÷ (24,447 - 953) = 1.234…
    expect(value).toBe(1.234);
  });
});

describe("「増えた」と数える幅", () => {
  const 起点 = reading(1_000, 953);

  /** 起点からの伸びが、基準の何割かを指定して1回ぶんを作る */
  function 伸び率(share: number): ProbeTokenReading {
    const rate = 起点.inputTokens / 起点.promptChars;
    const deltaChars = 送る字数(2_750) - 起点.promptChars;
    return {
      promptChars: 送る字数(2_750),
      inputTokens: 起点.inputTokens + Math.round(deltaChars * rate * share),
    };
  }

  test("揺れの幅の中なら、増えたと数える", () => {
    // 実機で全部届いた回は、どこを取っても基準の95%前後だった。
    // ここで落とすと、切られてもいない長さを「入らない」と数える
    for (const share of [1.0, 0.95, 0.9, 0.85]) {
      expect(judgeProbeGrowth(伸び率(share), [起点]).grew, `${share}`).toBe(
        true
      );
    }
  });

  test("幅を越えて足りなければ、伸びていないと数える", () => {
    // 切られた回は、実機では基準の14%以下だった
    for (const share of [0.7, 0.5, 0.14, 0]) {
      expect(judgeProbeGrowth(伸び率(share), [起点]).grew, `${share}`).toBe(
        false
      );
    }
  });

  test("刻みが細かい回は、数トークンの揺れで落とさない", () => {
    // 二分探索が詰まってくると、1回で増やす字数が数十字まで縮む。
    // 割合だけで見ると、詰め物の切れ目ひとつで「伸びなかった」に化ける
    const 直前: ProbeTokenReading = { promptChars: 10_000, inputTokens: 8_000 };
    const 少しだけ: ProbeTokenReading = {
      promptChars: 10_020,
      inputTokens: 8_006,
    };
    expect(judgeProbeGrowth(少しだけ, [直前]).grew).toBe(true);
  });

  test("比べる相手がいない最初の回は、伸びの起点にする", () => {
    expect(judgeProbeGrowth(reading(4_000, 3_385), []).grew).toBe(true);
  });

  test("もっと長い回が同じところで止まっているなら、この回も頭打ち", () => {
    /*
      二分探索は**上から降りてくる。** 「1回目からは確かに増えた」だけで
      通すと、天井の値に張り付いた回まで「入った」と読んでしまう
      （実効30,000字のモデルに、48,000字が通ってしまった）。
    */
    const readings = [reading(4_000, 3_385), reading(90_000, 24_600)];
    const growth = judgeProbeGrowth(reading(48_000, 24_600), readings);
    expect(growth.grew).toBe(false);
  });
});

describe("AIが返した数字を、そのまま信じない", () => {
  const readings = [reading(4_000, 3_385)];

  test("トークン数を返さないAIは、合言葉へ落とす", () => {
    for (const usage of [undefined, {}, { inputTokens: undefined }]) {
      expect(
        readProbeTokens({ promptChars: 送る字数(8_000), usage, readings })
      ).toEqual({ kind: "捨てる", reason: "申告なし" });
    }
  });

  test("0や負や数でない値は、測れていないのと同じ", () => {
    for (const inputTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        readProbeTokens({
          promptChars: 送る字数(8_000),
          usage: { inputTokens },
          readings,
        }),
        `${inputTokens}`
      ).toEqual({ kind: "捨てる", reason: "申告なし" });
    }
  });

  test("キャッシュが効いた回は使わない", () => {
    // 入力トークン数が実際より小さく出るので、伸びが止まったように見える
    expect(
      readProbeTokens({
        promptChars: 送る字数(8_000),
        usage: { inputTokens: 2_000, cachedInputTokens: 4_000 },
        readings,
      })
    ).toEqual({ kind: "捨てる", reason: "キャッシュが効いた" });
  });

  test("キャッシュ0は「数えたうえで効かなかった」なので、使う", () => {
    const result = readProbeTokens({
      promptChars: 送る字数(8_000),
      usage: { inputTokens: 6_621, cachedInputTokens: 0 },
      readings,
    });
    expect(result.kind).toBe("採用");
  });

  test("桁違いの値は捨てる", () => {
    const promptChars = 送る字数(1_000);
    expect(
      readProbeTokens({
        promptChars,
        usage: { inputTokens: promptChars * (PROBE_MAX_TOKENS_PER_CHAR + 1) },
        readings: [],
      })
    ).toEqual({ kind: "捨てる", reason: "桁違い" });
  });

  test("はっきり減った値は捨てる", () => {
    // より長く送ったのに少なく返ってきた。数字そのものが当てにならない
    expect(
      readProbeTokens({
        promptChars: 送る字数(8_000),
        usage: { inputTokens: 3_000 },
        readings,
      })
    ).toEqual({ kind: "捨てる", reason: "減っている" });
  });

  test("天井での小さな揺れは、減っても捨てない", () => {
    // ここを捨てると、いちばん知りたい「止まった」が読めなくなる
    const result = readProbeTokens({
      promptChars: 送る字数(8_000),
      usage: { inputTokens: 3_350 },
      readings,
    });
    expect(result.kind).toBe("採用");
  });
});

describe("字/トークンを採る条件", () => {
  test("1点しか無ければ採らない", () => {
    // その1点の比には指示ぶんの字数が乗っており、傾きより大きく出る
    // ——つまり危ない側へ倒れる
    expect(charsPerTokenFromProbe([reading(4_000, 3_385)])).toBeUndefined();
    expect(charsPerTokenFromProbe([])).toBeUndefined();
  });

  test("伸びていない2点からは採らない", () => {
    expect(
      charsPerTokenFromProbe([reading(4_000, 3_385), reading(8_000, 3_385)])
    ).toBeUndefined();
  });
});

/**
 * 探索を最後まで回す。`limitChars` 字までしか届かないAIを模す。
 *
 * 応答の入力トークン数は「届いた字数 × 密度」で作る——**切り捨てが
 * そのまま数字に出る**という、この測り方の前提そのものである。
 */
function runTokenProbe(
  ceilingChars: number,
  limitChars: number,
  tokensPerChar = 0.82
): { low: number; sizes: number[] } {
  const readings: ProbeTokenReading[] = [];
  const sizes: number[] = [];
  let low = 0;
  let state: ProbeState | undefined = startProbeState(ceilingChars);
  for (let guard = 0; state && guard < 100; guard += 1) {
    const promptChars = 送る字数(state.current);
    sizes.push(state.current);
    const next: ProbeTokenReading = {
      promptChars,
      inputTokens: Math.round(Math.min(promptChars, limitChars) * tokensPerChar),
    };
    const grew = judgeProbeGrowth(next, readings).grew;
    readings.push(next);
    if (grew) low = Math.max(low, state.current);
    state = nextProbeSize(state, grew);
  }
  expect(state).toBeUndefined();
  return { low, sizes };
}

describe("探索そのもの", () => {
  test("公称値へ跳んで切られたら、そこから間を詰めて実効へ寄る", () => {
    const { low, sizes } = runTokenProbe(180_000, 30_000);
    // 1回目は小さく、2回目で公称値まで跳ぶ（設計書6.59。ここは変えない）
    expect(sizes[0]).toBe(4_000);
    expect(sizes[1]).toBe(180_000);
    // **超えてはいけない。** 超えると、読めない長さで本文を切る
    expect(low).toBeLessThanOrEqual(30_000);
    expect(low).toBeGreaterThan(30_000 * 0.8);
  });

  test("いろいろな実効長で、超えず・近くまで寄る", () => {
    for (const limit of [8_000, 22_000, 60_000, 131_000]) {
      const { low } = runTokenProbe(180_000, limit);
      expect(low, `実効 ${limit}`).toBeLessThanOrEqual(limit);
      expect(low, `実効 ${limit}`).toBeGreaterThan(limit * 0.75);
    }
  });

  test("申告どおり全部読めるなら、天井まで通る", () => {
    const { low } = runTokenProbe(20_000, 999_999);
    expect(low).toBe(20_000);
  });
});

describe("指示文に雛形を残さない", () => {
  const { systemPrompt, userPrompt } = buildProbePrompt({
    fillerChars: 200,
    headWord: "あかさた",
    tailWord: "なにぬね",
  });

  test("以前の雛形が、どこにも残っていない", () => {
    // モデルはこの鉤括弧の中身をそのまま書き写して返してきた
    for (const text of [systemPrompt, userPrompt]) {
      expect(text).not.toContain("最初の合言葉 最後の合言葉");
      expect(text).not.toContain("最初の合言葉");
      expect(text).not.toContain("最後の合言葉");
    }
  });

  test("1文の中に「合言葉」が2度出てこない", () => {
    // 1文の中に2つ並んだ瞬間、それが書き写せる答えの形になる
    // （以前の末尾は、1文に3度入っていた）
    for (const sentence of `${systemPrompt}\n${userPrompt}`.split(/[。\n]/)) {
      const count = sentence.split("合言葉").length - 1;
      expect(count, sentence).toBeLessThanOrEqual(1);
    }
  });

  test("鉤括弧の中には、その回の合言葉しか入っていない", () => {
    // 『…』は「ここを書き写せ」の印である。中に説明の言葉を入れると、
    // モデルはそちらを書き写す
    const quoted = [...userPrompt.matchAll(/『([^』]*)』/gu)].map(
      (match) => match[1]
    );
    expect(quoted).toEqual(["あかさた", "なにぬね"]);
  });

  test("合言葉そのものは、これまでどおり user 側にだけ置く", () => {
    expect(systemPrompt).not.toContain("あかさた");
    expect(userPrompt).toContain("あかさた");
    expect(userPrompt).toContain("なにぬね");
  });
});

describe("結果の文言", () => {
  test("トークンで測ったときは、そう言う", () => {
    const text = describeProbeResult({
      low: 30_000,
      sides: { headDropped: false, tailDropped: false },
      measuredBy: "tokens",
    });
    expect(text).toContain("30,000");
    expect(text).toContain("入力トークン数の伸び");
    // どちら側が切られるかは、この測り方では分からない。言わない
    expect(text).not.toContain("末尾側");
    expect(text).not.toContain("分かりませんでした");
  });

  test("合言葉を写せなかった長さは、参考として添える", () => {
    const text = describeProbeResult({
      low: 30_000,
      sides: { headDropped: false, tailDropped: false },
      measuredBy: "tokens",
      wordCopyFailedChars: 4_000,
    });
    expect(text).toContain("4,000");
    expect(text).toContain("長さの判定には使っていません");
  });

  test("合言葉で測ったときは、弱い測り方であることを先に言う", () => {
    const text = describeProbeResult({
      low: 22_400,
      sides: { headDropped: false, tailDropped: true },
      measuredBy: "words",
    });
    expect(text).toContain("入力トークン数を返さない");
    expect(text).toContain("落ちることがある");
    expect(text).toContain("末尾側");
  });

  test("測り方を渡さなければ、これまでどおり合言葉として書く", () => {
    // 呼び忘れたときに、弱いほうだと名乗る（強いほうへ倒さない）
    const text = describeProbeResult({
      low: 10_000,
      sides: { headDropped: true, tailDropped: false },
    });
    expect(text).toContain("先頭側");
    expect(text).not.toContain("入力トークン数の伸び");
  });
});
