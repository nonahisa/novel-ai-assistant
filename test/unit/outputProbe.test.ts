import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_LINES,
  START_OUTPUT_LINES,
  buildOutputProbePrompt,
  countOutputLines,
  describeOutputProbeResult,
  nextOutputProbeSize,
  startOutputProbeState,
  type OutputProbeState,
} from "../../src/core/outputProbe";

/**
 * **1回の応答で書ける量を測る**（設計書6.61）。
 *
 * 守りたいのは2つ。
 *
 * 1. **数え方が甘くならないこと。** 途中を飛ばした返事を「そこまで書けた」と
 *    読むと、上限を実際より大きく見積もり、抽出のたびに応答が切れる
 * 2. **探索が必ず終わること。** 出力は生成なので、1回が読むよりずっと遅い
 */

/** 0001 から n 行ぶんの、正しい返事 */
function perfect(n: number): string {
  return Array.from({ length: n }, (_, i) =>
    String(i + 1).padStart(4, "0")
  ).join("\n");
}

describe("書けた行の数え方", () => {
  it("最後まで正しければ、その数", () => {
    expect(countOutputLines(perfect(120))).toBe(120);
  });

  it("途中で切られたら、切れたところまで", () => {
    expect(countOutputLines(perfect(50))).toBe(50);
  });

  it("**飛んだ先は数えない**", () => {
    // 「0001〜0003 まで書いて、飛んで 0500」を500行と読むと、
    // 上限を実際よりはるかに大きく見積もる
    const text = `${perfect(3)}\n0500\n0501`;
    expect(countOutputLines(text)).toBe(3);
  });

  it("前置きを書かれたら、0行として扱う", () => {
    // 「承知しました」で始まると、以降がずれる。数え直さない
    expect(countOutputLines(`承知しました。\n${perfect(10)}`)).toBe(0);
  });

  it("空行や前後の空白は気にしない", () => {
    expect(countOutputLines("\n 0001 \n\n0002\n")).toBe(2);
  });

  it("番号でない行が混じったら、そこで止める", () => {
    expect(countOutputLines(`${perfect(5)}\n（中略）\n0100`)).toBe(5);
  });

  it("何も返らなければ0", () => {
    expect(countOutputLines("")).toBe(0);
  });
});

describe("指示", () => {
  it("頼む行数を書く", () => {
    expect(buildOutputProbePrompt(250)).toContain("250 行");
  });

  it("省略を禁じる（「中略」で切り上げられると測れない）", () => {
    expect(buildOutputProbePrompt(250)).toContain("中略");
  });
});

/** 探索を最後まで回す。`trueLimit` 行までは書き切れるAIを模す */
function runProbe(
  ceilingLines: number,
  trueLimit: number
): { low: number; asked: number[] } {
  const asked: number[] = [];
  let low = 0;
  let state: OutputProbeState | undefined = startOutputProbeState(ceilingLines);
  for (let guard = 0; state && guard < 100; guard += 1) {
    asked.push(state.current);
    const completed = state.current <= trueLimit;
    if (completed) low = Math.max(low, state.current);
    state = nextOutputProbeSize(state, completed);
  }
  expect(state).toBeUndefined(); // 100回で終わらないのは回り続けている
  return { low, asked };
}

describe("探索", () => {
  it("最初は控えめに頼む", () => {
    expect(startOutputProbeState(4000).current).toBe(START_OUTPUT_LINES);
  });

  it("1回書けたら、次は上限まで跳ぶ", () => {
    const { asked, low } = runProbe(4000, 9999);
    expect(asked).toEqual([START_OUTPUT_LINES, 4000]);
    expect(low).toBe(4000);
  });

  it("跳んだ先が書けなければ、間を詰める", () => {
    const { asked, low } = runProbe(4000, 900);
    expect(asked[0]).toBe(START_OUTPUT_LINES);
    expect(asked[1]).toBe(4000);
    // 本当の上限を超えず、1割以内まで迫る
    expect(low).toBeLessThanOrEqual(900);
    expect(low).toBeGreaterThan(900 * 0.8);
  });

  it("まったく書けない相手には、粘らない", () => {
    // 1行も書けない＝長さの問題ではない。生成は遅いので、
    // 見込みの無い相手に何度も書かせるのは待ち時間の無駄になる
    const { asked, low } = runProbe(4000, 0);
    expect(low).toBe(0);
    expect(asked.length).toBeLessThan(20);
  });

  it("1回目に届かなくても、書ける量は見つける", () => {
    // 100行は無理でも10行は書ける、という相手
    const { low } = runProbe(4000, 10);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThanOrEqual(10);
  });

  it("桁が足りなくなる行数は頼まない", () => {
    expect(startOutputProbeState(99999).ceilingLines).toBe(MAX_OUTPUT_LINES);
  });
});

describe("結果の言葉", () => {
  it("トークン数を主にする（設定もチャンクもトークンで動くため）", () => {
    const text = describeOutputProbeResult({
      lines: 1200,
      tokens: 3600,
      reachedCeiling: false,
    });
    expect(text).toContain("3,600");
    expect(text).toContain("1,200");
  });

  it("上限まで書けたら、言い切らない", () => {
    const text = describeOutputProbeResult({
      lines: 4000,
      tokens: 12000,
      reachedCeiling: true,
    });
    expect(text).toContain("これより長く書ける可能性があります");
  });

  it("1回も書けなければ、長さのせいにしない", () => {
    const text = describeOutputProbeResult({
      lines: 0,
      tokens: undefined,
      reachedCeiling: false,
    });
    expect(text).toContain("設定か接続");
  });
});
