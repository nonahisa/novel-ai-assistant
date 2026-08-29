import { describe, expect, test } from "vitest";
import {
  MIN_CHUNK_CHARS,
  TOKENS_PER_CHAR,
  planChunkBudget,
  type Chunk,
} from "../../src/core/chunker";
import {
  OUTPUT_RESERVE_TOKENS,
  checkContextFit,
  contextOverflow,
} from "../../src/ai/contextGuard";
import { MeteredProvider } from "../../src/ai/meteredProvider";
import {
  AIError,
  recoveryForAIError,
  type AIProvider,
  type GenerateParams,
  type GenerateResult,
  type ModelInfo,
} from "../../src/ai/types";
import { retryOnOverflow } from "../../src/features/chunkRetry";
import {
  WORLDVIEW_MAX_CHARS,
  worldviewMaxChars,
} from "../../src/core/worldviewSelect";

/**
 * 本文を溢れさせない仕組みの検査（設計書6.27.10）。
 *
 * 守りたいのは1つだけ——**黙って切り捨てられる経路を残さない**。
 * Ollama は上限を超えた入力をエラーにせず捨てるので、切り捨ては
 * 「AIが本文の後半を読んでいない」という形でしか現れない。
 */

/** 本文の字数から、その本文が要るトークン数を出す（見積りの向きを揃える） */
function tokensFor(chars: number): number {
  return Math.ceil(chars * TOKENS_PER_CHAR);
}

describe("固定費を差し引いてから本文の割当を決める", () => {
  test("固定費が育つと、本文の字数が縮む", () => {
    const small = planChunkBudget({
      contextWindow: 32768,
      overheadChars: 3000,
      outputTokens: 8192,
      requestedChars: 20000,
    });
    const large = planChunkBudget({
      contextWindow: 32768,
      overheadChars: 12000,
      outputTokens: 8192,
      requestedChars: 20000,
    });

    expect(large.chunkChars).toBeLessThan(small.chunkChars);
  });

  test("余裕があっても、望んだ字数を超えない", () => {
    // 作者が「6,000字で」と指定しているのに、モデルが大きいからといって
    // 増やしてはいけない（指定が効かないように見える）
    const budget = planChunkBudget({
      contextWindow: 131072,
      overheadChars: 3000,
      outputTokens: 8192,
      requestedChars: 6000,
    });

    expect(budget.chunkChars).toBe(6000);
    expect(budget.reason).toBe("requested");
  });

  test("固定費に押されたときは、縮めたことが理由に出る", () => {
    const budget = planChunkBudget({
      contextWindow: 32768,
      overheadChars: 12000,
      outputTokens: 8192,
      requestedChars: 20000,
    });

    expect(budget.reason).toBe("shrunk_to_fit");
    expect(budget.chunkChars).toBeLessThan(20000);
    expect(budget.chunkChars).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS);
  });

  test("縮めても入らないときは下限で止め、理由を残す", () => {
    // 8,192のモデルへ、抽出の指示（約11,000字）を送ろうとした形
    const budget = planChunkBudget({
      contextWindow: 8192,
      overheadChars: 11000,
      outputTokens: 16384,
      requestedChars: 20000,
    });

    expect(budget.chunkChars).toBe(MIN_CHUNK_CHARS);
    expect(budget.reason).toBe("minimum");
  });

  test("下限より小さい指定を、下限まで太らせない", () => {
    // 入らないのを直そうとして送る量を増やすのは、向きが逆である。
    // この関数は本文を痩せさせるためのものである
    const budget = planChunkBudget({
      contextWindow: 8192,
      overheadChars: 11000,
      outputTokens: 16384,
      requestedChars: 1000,
    });

    expect(budget.chunkChars).toBe(1000);
  });

  test.each([5000, 20000, 40000])(
    "固定費が%d字でも、固定費＋本文＋出力が上限を超えない",
    (overheadChars) => {
      // **この上限の選び方には理由がある。** 差し引かずに20,000字のまま
      // 送ると、固定費40,000字のときだけ 93,907トークンになって溢れる。
      // 131,072のモデルでは溢れないので、差し引きの有無を見分けられない
      const contextWindow = 81920;
      const outputTokens = 8192;
      const requestedChars = 20000;
      const budget = planChunkBudget({
        contextWindow,
        overheadChars,
        outputTokens,
        requestedChars,
      });

      // 本文が縮んで吸収する。**縮めた結果が入っていなければ意味が無い**
      const need =
        tokensFor(overheadChars + budget.chunkChars) + outputTokens;
      expect(need).toBeLessThanOrEqual(contextWindow);

      // 「下限で止めた」＝入らないと分かっている状態では、上の式は
      // 成り立たない。**この3つはいずれも本文が吸収できる範囲である**
      expect(budget.reason).not.toBe("minimum");
    }
  );

  test("固定費が大きいときは、望んだ字数より実際に小さくなっている", () => {
    // 上の検査だけだと、「たまたま入っていた」のか「縮めたから入った」のか
    // 区別が付かない。縮んだことをここで確かめる
    const budget = planChunkBudget({
      contextWindow: 81920,
      overheadChars: 40000,
      outputTokens: 8192,
      requestedChars: 20000,
    });

    expect(budget.reason).toBe("shrunk_to_fit");
    expect(budget.chunkChars).toBeLessThan(20000);
  });
});

describe("送る直前の関所", () => {
  test("上限を超えるなら送らせない", () => {
    const error = contextOverflow({
      systemChars: 1000,
      userChars: 40000,
      outputTokens: 8192,
      contextWindow: 32768,
    });

    expect(error).toBeInstanceOf(AIError);
    expect(error?.kind).toBe("context_overflow");
  });

  test("入るなら通す", () => {
    expect(
      contextOverflow({
        systemChars: 1000,
        userChars: 10000,
        outputTokens: 8192,
        contextWindow: 131072,
      })
    ).toBeUndefined();
  });

  test("上限が分からないものは止めない", () => {
    // モデル情報が一時的に取れないだけで作品全体が処理できなくなるのは、
    // 作者から見て「壊れた」としか見えない
    expect(
      contextOverflow({
        systemChars: 1000,
        userChars: 999999,
        outputTokens: 8192,
        contextWindow: undefined,
      })
    ).toBeUndefined();
    expect(
      checkContextFit({
        systemChars: 1000,
        userChars: 999999,
        outputTokens: 8192,
        contextWindow: 0,
      }).fits
    ).toBe(true);
  });

  test("必要量と上限の数字が、そのまま文面に出る", () => {
    // 「入りません」だけでは、どれくらい減らせばよいのか分からない
    const error = contextOverflow({
      systemChars: 1000,
      userChars: 40000,
      outputTokens: 8192,
      contextWindow: 32768,
    });

    const need = tokensFor(41000) + 8192;
    expect(error?.message).toContain(need.toLocaleString("en-US"));
    expect(error?.message).toContain("32,768");
    // 内訳（どこが膨らんでいるか）も残す
    expect(error?.detail).toContain("40,000");
  });

  test("次に取れる操作が3つ示される", () => {
    const recovery = recoveryForAIError(
      new AIError("入りません", "context_overflow")
    );

    expect(recovery).toContain("小さく分ける");
    expect(recovery).toContain("大きいモデル");
    expect(recovery).toContain("参照資料");
  });
});

/** 関所は全プロバイダ共通の包みに置いてある。そこを通ることを確かめる */
describe("包みが関所を通す", () => {
  function provider(options: {
    contextWindow?: number;
    onGenerate: () => void;
  }): AIProvider {
    const base: AIProvider = {
      id: "ollama",
      displayName: "Ollama（ローカル）",
      isPaid: false,
      isConfigured: async () => true,
      testConnection: async () => ({ ok: true, message: "" }),
      listModels: async () => [],
      generate: async (): Promise<GenerateResult> => {
        options.onGenerate();
        return { text: "{}", truncated: false, elapsedMs: 1 };
      },
    };
    if (options.contextWindow === undefined) return base;
    return {
      ...base,
      getModel: async (id: string): Promise<ModelInfo | undefined> => ({
        id,
        displayName: id,
        contextWindow: options.contextWindow!,
        parameterSize: null,
        capabilities: [],
        tier: "standard",
      }),
    };
  }

  function params(userChars: number): GenerateParams {
    return {
      systemPrompt: "あ".repeat(1000),
      userPrompt: "い".repeat(userChars),
      model: "gemma4:e4b",
      temperature: 0,
    };
  }

  test("入らないものは、1回もAIへ届かない", async () => {
    let called = 0;
    const wrapped = new MeteredProvider(
      provider({ contextWindow: 32768, onGenerate: () => called++ })
    );

    await expect(wrapped.generate(params(40000))).rejects.toMatchObject({
      kind: "context_overflow",
    });
    expect(called).toBe(0);
  });

  test("入るものはそのまま送る", async () => {
    let called = 0;
    const wrapped = new MeteredProvider(
      provider({ contextWindow: 131072, onGenerate: () => called++ })
    );

    await wrapped.generate(params(10000));
    expect(called).toBe(1);
  });

  test("上限を引けないプロバイダでは、これまでどおり送る", async () => {
    let called = 0;
    const wrapped = new MeteredProvider(
      provider({ onGenerate: () => called++ })
    );

    await wrapped.generate(params(40000));
    expect(called).toBe(1);
  });

  test("出力の見込みが渡されれば、その分も数える", async () => {
    let called = 0;
    // 入力だけなら入るが、出力の見込みを足すと超える大きさにする
    const inputTokens = tokensFor(1000 + 20000);
    const contextWindow = inputTokens + OUTPUT_RESERVE_TOKENS + 1000;
    const wrapped = new MeteredProvider(
      provider({ contextWindow, onGenerate: () => called++ })
    );

    await wrapped.generate(params(20000));
    expect(called).toBe(1);

    await expect(
      wrapped.generate({ ...params(20000), maxOutputTokens: 32768 })
    ).rejects.toMatchObject({ kind: "context_overflow" });
    expect(called).toBe(1);
  });
});

describe("入らなかったときの逃げ道", () => {
  const overflow = new AIError(
    "本文と資料を合わせた量（約60,000トークン）が、" +
      "このモデルの上限（32,768トークン）を超えています。",
    "context_overflow"
  );

  /** まとめたチャンク（3話ぶん）を1つ作る */
  function merged(): Chunk {
    const bodies = ["あ", "い", "う"].map((mark) => mark.repeat(3000));
    const text = bodies.join("");
    let at = 0;
    return {
      filePath: "001.txt",
      index: 0,
      text,
      startLine: 0,
      chapterStart: 1,
      chapterEnd: 3,
      hash: "merged",
      wholeFile: true,
      segments: bodies.map((body, index) => {
        const start = at;
        at += body.length;
        return {
          filePath: `00${index + 1}.txt`,
          chapterStart: index + 1,
          chapterEnd: index + 1,
          start,
          end: at,
          startLine: 0,
        };
      }),
    };
  }

  function single(chars: number): Chunk {
    // 段落の切れ目を入れておく（半分に割るときの区切りに使う）
    const half = "あ".repeat(Math.floor(chars / 2));
    const text = `${half}\n\n${half}`;
    return {
      filePath: "001.txt",
      index: 0,
      text,
      startLine: 0,
      chapterStart: 1,
      chapterEnd: 1,
      hash: `single-${chars}`,
      wholeFile: true,
    };
  }

  test("まず、まとめたぶんを話ごとに戻す", () => {
    // 半分に割ると内訳（どこからどこまでが何話か）が消える。
    // 話ごとに戻せるうちは、そちらが先である
    const retry = retryOnOverflow(merged(), overflow);

    expect(retry.kind).toBe("split");
    if (retry.kind !== "split") return;
    expect(retry.parts).toHaveLength(3);
    expect(retry.parts.map((part) => part.chapterStart)).toEqual([1, 2, 3]);
  });

  test("まとめていないものは、半分に割る", () => {
    const retry = retryOnOverflow(single(8000), overflow);

    expect(retry.kind).toBe("split");
    if (retry.kind !== "split") return;
    expect(retry.parts).toHaveLength(2);
    // 本文は1文字も落とさない
    expect(retry.parts.map((part) => part.text).join("")).toBe(
      single(8000).text
    );
  });

  test("下限より小さくは割らず、失敗として理由を残す", () => {
    // 1,500字を下回るところまで割ると、文の途中で切れて誤検出のもとになる
    const retry = retryOnOverflow(single(2000), overflow);

    expect(retry.kind).toBe("give_up");
    // **必要量と上限の数字を落とさない。** 作者の唯一の手がかりである
    expect(retry.note).toContain("60,000");
    expect(retry.note).toContain("32,768");
    expect(retry.note).toContain("大きいモデル");
  });

  test("割る → 割る → 諦める の順に降りていく", () => {
    // まとめたもの（3話）→ 1話ずつ → 半分 → 下限で諦める
    const first = retryOnOverflow(merged(), overflow);
    expect(first.kind).toBe("split");
    if (first.kind !== "split") return;

    const second = retryOnOverflow(first.parts[0], overflow);
    expect(second.kind).toBe("split");
    if (second.kind !== "split") return;

    // 1,500字ずつまで割れたら、そこが底
    expect(retryOnOverflow(second.parts[0], overflow).kind).toBe("give_up");
  });
});

describe("参照資料の上限は、モデルの大きさに合わせる", () => {
  test("32kのモデルでは、固定の30,000字より小さくなる", () => {
    // 30,000字は約43,000トークン。本文を1文字も足さないうちに上限を超える
    const limit = worldviewMaxChars(32768);

    expect(limit).toBeLessThan(WORLDVIEW_MAX_CHARS);
    expect(limit).toBeLessThan(Math.floor(32768 * 0.7));
  });

  test("上限が分からないときは、固定の頭打ちのまま", () => {
    expect(worldviewMaxChars(undefined)).toBe(WORLDVIEW_MAX_CHARS);
  });

  test("上限そのものは超えない", () => {
    expect(worldviewMaxChars(10_000_000)).toBe(WORLDVIEW_MAX_CHARS);
  });
});
