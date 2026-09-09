import { describe, expect, test } from "vitest";
import {
  MIN_PROBE_CHARS,
  PROBE_CONVERGENCE_RATIO,
  START_PROBE_CHARS,
  buildProbeFiller,
  buildProbePrompt,
  describeProbeResult,
  judgeProbeAnswer,
  makeProbeWords,
  nextProbeSize,
  probeCharsToTokens,
  probeOverheadChars,
  startProbeState,
  worstCaseProbeChars,
  type ProbeState,
} from "../../src/core/contextProbe";

/**
 * AIが実際に読める長さを測る仕組みの検査（設計書6.27.11）。
 *
 * 守りたいのは2つ。
 *
 * 1. **合図が「何も読めていなくても返る語」にならないこと。**
 *    「はい」が返っただけで「読めた」と判定しては、測る意味が無い
 * 2. **探索が必ず終わること。** 有料AIでは、1回が料金である
 */

describe("合言葉", () => {
  test("その回だけの無作為な語で、毎回ちがう", () => {
    // Math.random をそのまま使う。**固定した乱数で通しても、
    // 「毎回ちがう」ことの確認にはならない**
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { headWord, tailWord } = makeProbeWords(Math.random);
      seen.add(headWord);
      seen.add(tailWord);
    }
    // 4文字のひらがな（46字から選ぶ）を400個引いて、
    // ほとんど重ならないことを見る
    expect(seen.size).toBeGreaterThan(300);
  });

  test("ひらがな4文字になる", () => {
    for (let i = 0; i < 100; i += 1) {
      const { headWord, tailWord } = makeProbeWords(Math.random);
      expect(headWord).toMatch(/^[ぁ-ん]{4}$/u);
      expect(tailWord).toMatch(/^[ぁ-ん]{4}$/u);
    }
  });

  test("「はい」など、読めていなくても返る語を含まない", () => {
    const banned = ["はい", "いいえ", "うん", "ええ", "そう", "です", "ます"];
    for (let i = 0; i < 500; i += 1) {
      const { headWord, tailWord } = makeProbeWords(Math.random);
      for (const fragment of banned) {
        expect(headWord.includes(fragment), `${headWord}`).toBe(false);
        expect(tailWord.includes(fragment), `${tailWord}`).toBe(false);
      }
    }
  });

  test("先頭と末尾で違う語になる", () => {
    for (let i = 0; i < 100; i += 1) {
      const { headWord, tailWord } = makeProbeWords(Math.random);
      // 同じだと、片方だけ返ったのか両方返ったのか区別できない
      expect(headWord).not.toBe(tailWord);
    }
  });

  test("乱数が偏っていても終わる", () => {
    // 引き直しで作っていると、ここで固まる
    const { headWord } = makeProbeWords(() => 0);
    expect(headWord).toHaveLength(4);
  });
});

describe("返事の判定", () => {
  test("空白・記号・改行の違いを無視する", () => {
    const judged = judgeProbeAnswer(
      "『あかさた』 ・ 『なにぬね』。\n",
      "あかさた",
      "なにぬね"
    );
    expect(judged).toEqual({ head: true, tail: true });
  });

  test("両方あれば両方 true", () => {
    const judged = judgeProbeAnswer("あかさた なにぬね", "あかさた", "なにぬね");
    expect(judged).toEqual({ head: true, tail: true });
  });

  test("末尾が切られた返事は、先頭だけ true", () => {
    // 後ろを切られると、末尾の合言葉を知らないまま答えることになる
    const judged = judgeProbeAnswer("あかさた", "あかさた", "なにぬね");
    expect(judged).toEqual({ head: true, tail: false });
  });

  test("先頭が切られた返事は、末尾だけ true", () => {
    const judged = judgeProbeAnswer(
      "最後の合言葉は『なにぬね』です。",
      "あかさた",
      "なにぬね"
    );
    expect(judged).toEqual({ head: false, tail: true });
  });

  test("何も返らなければ両方 false", () => {
    const judged = judgeProbeAnswer("わかりません。", "あかさた", "なにぬね");
    expect(judged).toEqual({ head: false, tail: false });
  });

  test("空の合言葉は「含まれている」ことにしない", () => {
    // includes("") は常に true になる。ここで取りこぼすと、
    // 何も読めていない回が「読めた」に化ける
    const judged = judgeProbeAnswer("なんでもよい返事", "", "");
    expect(judged).toEqual({ head: false, tail: false });
  });
});

describe("検査の組み立て", () => {
  test("詰め物はちょうどその字数になる", () => {
    // **連続した値で確かめる。** 改行の数え方を1つ間違えると、
    // 「文の切れ目にちょうど乗った字数のときだけ1字足りない」という
    // 出方をする（実際にそうなった）。飛び飛びの値では見つからない
    for (let chars = 0; chars <= 400; chars += 1) {
      expect(buildProbeFiller(chars), `${chars}字`).toHaveLength(chars);
    }
    for (const chars of [4000, 12345, 180000]) {
      expect(buildProbeFiller(chars), `${chars}字`).toHaveLength(chars);
    }
  });

  test("詰め物は同じ字の連打ではなく、日本語の文でできている", () => {
    const filler = buildProbeFiller(200);
    expect(filler).toContain("。");
    // 1種類の文の繰り返しだけにしない（トークンへの分かれ方が本文と離れる）
    expect(new Set(filler.split("\n")).size).toBeGreaterThan(1);
  });

  test("合言葉は user 側にだけ置く", () => {
    // system が生き残ると、本文が切られていても合言葉を答えられてしまう
    const { systemPrompt, userPrompt } = buildProbePrompt({
      fillerChars: 100,
      headWord: "あかさた",
      tailWord: "なにぬね",
    });
    expect(systemPrompt).not.toContain("あかさた");
    expect(systemPrompt).not.toContain("なにぬね");
    expect(userPrompt).toContain("あかさた");
    expect(userPrompt).toContain("なにぬね");
  });

  test("末尾の合言葉と返事の指示は、いちばん後ろに置く", () => {
    const { userPrompt } = buildProbePrompt({
      fillerChars: 3000,
      headWord: "あかさた",
      tailWord: "なにぬね",
    });
    expect(userPrompt.indexOf("あかさた")).toBeLessThan(
      userPrompt.indexOf("なにぬね")
    );
    expect(userPrompt.trimEnd().endsWith("合言葉だけを書いてください。")).toBe(
      true
    );
  });

  test("「これまでの指示を無視して」とは書かない", () => {
    // 作者の原案から変えた点。安全学習で断られることがある
    const { systemPrompt, userPrompt } = buildProbePrompt({
      fillerChars: 10,
      headWord: "あかさた",
      tailWord: "なにぬね",
    });
    for (const text of [systemPrompt, userPrompt]) {
      expect(text).not.toContain("無視");
    }
  });

  test("詰め物以外にかかる字数を測れる", () => {
    const overhead = probeOverheadChars();
    const { systemPrompt, userPrompt } = buildProbePrompt({
      fillerChars: 5000,
      headWord: "あかさた",
      tailWord: "なにぬね",
    });
    expect(systemPrompt.length + userPrompt.length).toBe(overhead + 5000);
  });
});

/**
 * 探索を最後まで回す。
 *
 * `trueLimit` 字までは両方返り、それを超えると返らないAIを模す。
 * 実際に送る側（`features/measureContext.ts`）と同じ順で回す。
 */
function runProbe(
  ceilingChars: number,
  trueLimit: number
): { low: number; sizes: number[]; lows: number[] } {
  const sizes: number[] = [];
  const lows: number[] = [];
  let low = 0;
  let state: ProbeState | undefined = startProbeState(ceilingChars);
  for (let guard = 0; state && guard < 100; guard += 1) {
    sizes.push(state.current);
    const bothReturned = state.current <= trueLimit;
    if (bothReturned) low = Math.max(low, state.current);
    lows.push(low);
    state = nextProbeSize(state, bothReturned);
  }
  expect(state).toBeUndefined(); // 100回で終わらないのは回り続けている
  return { low, sizes, lows };
}

describe("二分探索", () => {
  test("最初は4,000字から始める", () => {
    expect(startProbeState(180000).current).toBe(START_PROBE_CHARS);
  });

  test("8回程度で収束する", () => {
    // 128Kトークンを名乗るモデルで、実際には約60,000字しか読めない場合
    const { sizes } = runProbe(180000, 60000);
    expect(sizes.length).toBeLessThanOrEqual(10);
    expect(sizes.length).toBeGreaterThan(4);
  });

  test("求めた値は、本当の上限を超えず、1割以内まで迫る", () => {
    for (const trueLimit of [7000, 22000, 60000, 131000]) {
      const { low } = runProbe(180000, trueLimit);
      // **超えてはいけない。** 超えると、読めない長さで本文を切る
      expect(low).toBeLessThanOrEqual(trueLimit);
      expect(low).toBeGreaterThan(trueLimit * (1 - PROBE_CONVERGENCE_RATIO * 2));
    }
  });

  test("両方返った最大は、下がらない", () => {
    const { lows } = runProbe(180000, 60000);
    for (let i = 1; i < lows.length; i += 1) {
      expect(lows[i]).toBeGreaterThanOrEqual(lows[i - 1]);
    }
    // 伸ばす段階では、実際に増えている
    expect(lows[lows.length - 1]).toBeGreaterThan(lows[0]);
  });

  /**
   * **1回目のあとは、公称値へ一気に跳ぶ**（設計書6.59）。
   *
   * 倍々に伸ばしていた頃は 4,000 → 8,000 → 16,000 → 20,000 と4回かかった。
   * 申告どおり読めるモデルでは、その途中の回は**全部「読めた」で終わる**
   * ——分かることが無いのに送っていた（作者の実測では6回ぶん）。
   *
   * **1回目の小さい回だけは残す。** 失敗したときに「長すぎた」のか
   * 「鍵が違う・繋がらない」のかを見分ける拠り所になる。
   */
  test("1回通ったら、次は公称値まで跳ぶ", () => {
    const { low, sizes } = runProbe(20000, 999999);
    expect(low).toBe(20000);
    expect(sizes[sizes.length - 1]).toBe(20000);
    expect(sizes).toEqual([4000, 20000]);
  });

  test("跳んだ先が読めなければ、間を詰めて探す", () => {
    // 実効の上限が 30,000 のモデルに、公称 180,000 と言われている場合
    const { low, sizes } = runProbe(180000, 30000);

    // 1回目は小さく、2回目でいきなり公称値まで跳ぶ
    expect(sizes[0]).toBe(4000);
    expect(sizes[1]).toBe(180000);
    // そこから間を詰めて、実効の上限へ寄っていく
    expect(low).toBeGreaterThan(20000);
    expect(low).toBeLessThanOrEqual(30000);
  });

  test("上限が最初の字数より小さくても、1回で終わる", () => {
    const { low, sizes } = runProbe(3000, 999999);
    expect(sizes).toEqual([3000]);
    expect(low).toBe(3000);
  });

  test("まったく読めないときは、底で打ち切る", () => {
    const { low, sizes } = runProbe(180000, 0);
    expect(low).toBe(0);
    // 底（500字）より短いところを延々と刻まない
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(MIN_PROBE_CHARS);
    expect(sizes.length).toBeLessThanOrEqual(6);
  });
});

describe("送る量の見込み", () => {
  test("実際に走らせた合計を、必ず上回る", () => {
    // 下回ると、作者に見せた金額より多く請求されることになる。
    // 「上限の2倍」のような倍率で見積もると、間を詰める段が
    // 勘定から落ちて実際に下回った
    const ceilingChars = 183240; // 256Kトークン相当
    const worst = worstCaseProbeChars(ceilingChars);
    for (const trueLimit of [0, 3000, 7000, 22000, 60000, 131000, 999999]) {
      const { sizes } = runProbe(ceilingChars, trueLimit);
      const actual = sizes.reduce((sum, size) => sum + size, 0);
      expect(actual, `上限 ${trueLimit}`).toBeLessThanOrEqual(worst);
    }
  });

  test("倍々に伸ばす段だけでは足りない", () => {
    // ここが等しく（あるいは小さく）なったら、見積もりが
    // また倍率に戻っている
    const ceilingChars = 183240;
    expect(worstCaseProbeChars(ceilingChars)).toBeGreaterThan(ceilingChars * 3);
  });

  test("上限が小さくても、際限なくは増えない", () => {
    // 1回目で落ちると、そこから下へ刻んでいく枝が伸びる。
    // 上限の何倍にもなるが、有限で、上限に比例した範囲に収まる
    const worst = worstCaseProbeChars(3000);
    expect(worst).toBeGreaterThanOrEqual(3000);
    expect(worst).toBeLessThan(3000 * 6);
  });
});

describe("結果の文言", () => {
  test("字数とトークン数が両方入る", () => {
    const text = describeProbeResult({
      low: 22400,
      sides: { headDropped: false, tailDropped: true },
    });
    expect(text).toContain("22,400");
    expect(text).toContain(probeCharsToTokens(22400).toLocaleString("ja-JP"));
    expect(text).toContain("末尾側");
  });

  test("先頭が切られたときは、そう書く", () => {
    const text = describeProbeResult({
      low: 10000,
      sides: { headDropped: true, tailDropped: false },
    });
    expect(text).toContain("先頭側");
    expect(text).not.toContain("末尾側");
  });

  test("上限まで届いたら、言い切らない", () => {
    const text = describeProbeResult({
      low: 20000,
      sides: { headDropped: false, tailDropped: false },
      ceilingChars: 20000,
    });
    expect(text).toContain("20,000");
    expect(text).toContain("可能性");
  });

  test("何も返らなかったときは、上限の話をしない", () => {
    const text = describeProbeResult({
      low: 0,
      sides: { headDropped: false, tailDropped: false },
    });
    expect(text).toContain("合言葉が返りませんでした");
    expect(text).not.toContain("実効の上限");
  });
});
