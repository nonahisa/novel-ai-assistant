import { describe, expect, test } from "vitest";
import {
  TUNING_STAGES,
  describeStagePlan,
  fitWorkRate,
  judgeThinking,
  parseDeclaredContextLimit,
  plannedCallCount,
  plannedStages,
  predictWorkSeconds,
  sawThinking,
  WORK_REFERENCE_CHARS,
} from "../../../src/core/tuningStages";
import { CHUNK_TIME_LADDER } from "../../../src/core/chunkTimeFit";

/**
 * AIチューニングの「仕事に近い形の測定」の判断（設計書6.49.9。作者の判断、
 * 2026-09-26）。
 *
 * ここで守るのは4つである。
 *
 * 1. **段の並びから回数が決まる**——有料AIの確認に出す回数を、段の一覧の
 *    外で数えない（写しを作ると、段を足したときに確認の数字だけ古くなる）
 * 2. **考えるモデルの見分けは、返った応答で見えたことだけから**（規則5
 *    「失敗から学習しない」）
 * 3. **時間の式は、揺れで負にならず、長めに出る側へ倒れる**
 * 4. **断られた文から読むのは、上限超えのときだけ出る定型の語に続く数字**
 *    （規則5「エラー文から原因を当てにいかない」との折り合い。6.22.1①）
 */

const SAKURA = { providerId: "sakura", local: false } as const;
const OLLAMA = { providerId: "ollama", local: true } as const;
const GEMINI = { providerId: "gemini", local: false } as const;

describe("段の並びと回数", () => {
  test("並びは「思考の見分け → 仕事に近い時間 → 読める長さの申告」", () => {
    // 思考の見分けが先——手元のAIでは、ここでモデルが読み込まれる。
    // 読み込みの時間を時間の段に混ぜないための順である
    expect(TUNING_STAGES.map((stage) => stage.id)).toEqual([
      "thinking",
      "work",
      "declaredLimit",
    ]);
  });

  test("読める長さの申告は、申告が当て推量のプロバイダ（さくら・ChatGPT）だけ", () => {
    // APIが長さを教える相手に断らせて読む理由は無い（規則6）
    expect(plannedStages(SAKURA).map((stage) => stage.id)).toContain("declaredLimit");
    expect(
      plannedStages({ providerId: "openai", local: false }).map((stage) => stage.id)
    ).toContain("declaredLimit");
    expect(plannedStages(OLLAMA).map((stage) => stage.id)).not.toContain(
      "declaredLimit"
    );
    expect(plannedStages(GEMINI).map((stage) => stage.id)).not.toContain(
      "declaredLimit"
    );
  });

  test("回数は段ごとの最大の合計。手元のAIは読み込みの1回を足す", () => {
    // さくら：思考2＋時間2＋申告2
    expect(plannedCallCount(SAKURA)).toBe(6);
    // Ollama：思考2＋時間3（読み込みの1回）
    expect(plannedCallCount(OLLAMA)).toBe(5);
    // Gemini：思考2＋時間2
    expect(plannedCallCount(GEMINI)).toBe(4);
  });

  test("確認に出す内訳は、段ごとの回数と合計の両方を言う", () => {
    const text = describeStagePlan(SAKURA);
    expect(text).toContain("考えるモデルかの見分け 2回");
    expect(text).toContain("仕事に近い形の時間 2回");
    expect(text).toContain("読める長さの申告 2回");
    expect(text).toContain("合わせて最大 6 回");
    // 少なく見せる側へ倒さない。途中で決まれば少なく済むことを断る
    expect(text).toContain("これより少なく済みます");
  });

  test("段の一覧を差し替えれば、回数もそれに従う（段を足す土台）", () => {
    const extra = [
      ...TUNING_STAGES,
      {
        id: "work" as const,
        label: "精度",
        appliesTo: () => true,
        maxCalls: () => 3,
      },
    ];
    expect(plannedCallCount(GEMINI, extra)).toBe(7);
    expect(describeStagePlan(GEMINI, extra)).toContain("精度 3回");
  });
});

describe("考えるモデルの見分け", () => {
  const quiet = { thinkingChars: 0, answerChars: 400, outputTokens: 300 };
  const thinking = { thinkingChars: 1800, answerChars: 400, outputTokens: 2100 };

  test("思考の欄に字があれば、思考が出たと見る", () => {
    expect(sawThinking(thinking)).toBe(true);
    expect(sawThinking(quiet)).toBe(false);
  });

  test("思考の欄が無くても、出力トークンが答えに比べて多すぎれば思考と見る", () => {
    // 答え400字に対して2,000トークン——答えの外で何かを書いている
    expect(
      sawThinking({ thinkingChars: 0, answerChars: 400, outputTokens: 2000 })
    ).toBe(true);
    // 答え400字に600トークン（1.5倍＋256以内）は、答えだけと見る
    expect(
      sawThinking({ thinkingChars: 0, answerChars: 400, outputTokens: 600 })
    ).toBe(false);
    // トークン数を申告しないAIでは、欄が無ければ分からない＝出ていないと見る
    expect(sawThinking({ thinkingChars: 0, answerChars: 400 })).toBe(false);
  });

  test("止める指定なしで考えず、ありでも考えない → 考えないモデル", () => {
    expect(judgeThinking(quiet, quiet)).toEqual({ thinkingSeen: false });
  });

  test("止める指定なしで考え、ありで止まる → 効く", () => {
    expect(judgeThinking(thinking, quiet)).toEqual({
      thinkingSeen: true,
      thinkingOffWorks: true,
    });
  });

  test("止める指定ありでも考える → 効かない。思考のぶんを余白つきで見込む", () => {
    const verdict = judgeThinking(thinking, thinking);
    expect(verdict?.thinkingSeen).toBe(true);
    expect(verdict?.thinkingOffWorks).toBe(false);
    // 出力2,100 − 答え400 = 1,700トークン。1.5倍して256刻みに切り上げ → 2,560
    expect(verdict?.thinkingOverheadTokens).toBe(2560);
  });

  test("止める指定を送った回が失敗しても、「効かない」とは決めない（規則5）", () => {
    // 失敗の原因は別（残高・上限）かもしれない。分かるのは「考えるモデル」までである
    expect(judgeThinking(thinking, undefined)).toEqual({ thinkingSeen: true });
  });

  test("止める指定なしの回が失敗しても、止めた回で考えていれば「効かない」は言える", () => {
    expect(judgeThinking(undefined, thinking)?.thinkingOffWorks).toBe(false);
  });

  test("どちらも返らなければ、何も覚えない", () => {
    expect(judgeThinking(undefined, undefined)).toBeUndefined();
    // 止めた回で考えなかっただけでは、考えるモデルかどうかは分からない
    expect(judgeThinking(undefined, quiet)).toBeUndefined();
  });
});

describe("仕事に近い形の時間", () => {
  test("短い回と長い回から、固定のぶんと1000字あたりを分ける", () => {
    // 300字で8秒、1,500字で20秒 → 1000字あたり10秒、固定5秒
    const rate = fitWorkRate([
      { bodyChars: 300, seconds: 8 },
      { bodyChars: 1500, seconds: 20 },
    ]);
    expect(rate).toEqual({ fixedSeconds: 5, secondsPer1000Chars: 10 });
    expect(predictWorkSeconds(rate!, 2000)).toBe(25);
  });

  test("長い回のほうが速かった（揺れが差を上回った）ときは、長めに出る側へ倒す", () => {
    // 固定0、長い回の時間をすべて字数のせいにする
    const rate = fitWorkRate([
      { bodyChars: 300, seconds: 6 },
      { bodyChars: 1500, seconds: 5.9 },
    ]);
    expect(rate?.fixedSeconds).toBe(0);
    expect(rate?.secondsPer1000Chars).toBeCloseTo(3.9, 1);
    // 見込みは負にならない
    expect(predictWorkSeconds(rate!, WORK_REFERENCE_CHARS)).toBeGreaterThan(0);
  });

  test("傾きが急すぎて固定のぶんが負になるときも、同じく長めに倒す", () => {
    const rate = fitWorkRate([
      { bodyChars: 300, seconds: 1 },
      { bodyChars: 1500, seconds: 30 },
    ]);
    expect(rate?.fixedSeconds).toBe(0);
    expect(rate?.secondsPer1000Chars).toBe(20);
  });

  test("決められないときは undefined（1回だけ・同じ長さ・0秒）", () => {
    expect(fitWorkRate([{ bodyChars: 300, seconds: 8 }])).toBeUndefined();
    expect(
      fitWorkRate([
        { bodyChars: 300, seconds: 8 },
        { bodyChars: 300, seconds: 9 },
      ])
    ).toBeUndefined();
    expect(
      fitWorkRate([
        { bodyChars: 300, seconds: 0 },
        { bodyChars: 1500, seconds: 20 },
      ])
    ).toBeUndefined();
  });

  test("待ち時間の見立てに使う字数は、自動で決めるチャンクのいちばん大きい段", () => {
    // 写しを作らない——段を変えたら、ここも一緒に動く
    expect(WORK_REFERENCE_CHARS).toBe(CHUNK_TIME_LADDER[0]);
  });
});

describe("断られた文から、読める長さを読む", () => {
  test("実測で見た3つの言い回しを読む", () => {
    // さくら llm-jp（2026-09-26）
    expect(
      parseDeclaredContextLimit(
        "This model's maximum context length is 4096 tokens and your request has 16 input tokens (11264 > 4096 - 16)."
      )
    ).toBe(4096);
    // さくら Phi（2026-09-26）。名前が続く形
    expect(
      parseDeclaredContextLimit(
        "max_tokens=11264 cannot be greater than max_model_len=max_total_tokens=4096. Please request fewer output tokens."
      )
    ).toBe(4096);
    // さくら gpt-oss-120b（2026-08-30）
    expect(
      parseDeclaredContextLimit(
        "Input length (170068) exceeds model's maximum context length (131072)."
      )
    ).toBe(131072);
  });

  test("長さを述べていない断りからは読まない", () => {
    // 出力の上限だけを述べる言い回し（読める長さではない）
    expect(
      parseDeclaredContextLimit(
        "max_tokens is too large: 2000000. This model supports at most 16384 completion tokens, whereas you provided 2000000."
      )
    ).toBeUndefined();
    // 残高・レート上限（長さとは無関係）
    expect(parseDeclaredContextLimit("insufficient credit")).toBeUndefined();
    expect(parseDeclaredContextLimit("Rate limit reached for requests")).toBeUndefined();
    expect(parseDeclaredContextLimit("")).toBeUndefined();
  });

  test("ありえない大きさの数字は信じない", () => {
    expect(
      parseDeclaredContextLimit("This model's maximum context length is 12 tokens")
    ).toBeUndefined();
    expect(
      parseDeclaredContextLimit("This model's maximum context length is 99999999999 tokens")
    ).toBeUndefined();
  });
});
