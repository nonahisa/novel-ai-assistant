import { describe, expect, test, vi } from "vitest";

/**
 * 送信量の記録（`usage.md`）への書き込みを覗く。
 *
 * **本物は作品フォルダーへ書く。** ここで見たいのは「関所で止めた回にも
 * 1行残るか」なので、書き込み先ではなく**呼ばれたかどうか**を控える。
 */
const usageCalls = vi.hoisted(
  () => [] as Array<[string, Record<string, unknown>]>
);
vi.mock("../../../src/core/usageLog", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appendUsageLog: (folder: string, entry: Record<string, unknown>) => {
    usageCalls.push([folder, entry]);
  },
}));

import {
  MIN_CHUNK_CHARS,
  TOKENS_PER_CHAR,
  planChunkBudget,
  type Chunk,
  type ChunkBudget,
} from "../../../src/core/chunker";
import {
  describeChunkSettings,
  type ChunkSettings,
} from "../../../src/features/chunkSettings";
import {
  CONTEXT_GUARD_EXEMPT_FEATURE,
  OUTPUT_RESERVE_TOKENS,
  checkContextFit,
  contextOverflow,
  skipsContextGuard,
} from "../../../src/ai/contextGuard";
import { MeteredProvider } from "../../../src/ai/meteredProvider";
import {
  AIError,
  recoveryForAIError,
  type AIProvider,
  type GenerateParams,
  type GenerateResult,
  type ModelInfo,
} from "../../../src/ai/types";
import { retryOnOverflow } from "../../../src/features/chunkRetry";
import {
  WORLDVIEW_MAX_CHARS,
  worldviewMaxChars,
} from "../../../src/core/worldviewSelect";
import { workspace } from "../support/vscodeStub";

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

  /**
   * **既定の見込みは設定値（16,384）である**（0.32.11、設計書6.77の第2段）。
   *
   * 以前はここが `OUTPUT_RESERVE_TOKENS`（8,192）だった。関所が8,192で
   * 判断し、実際には設定値の16,384が送られていたので、**関所を通ったのに
   * 上限を超える**という逆向きの食い違いが残っていた。見込みと実送信を
   * 同じ式（`params.maxOutputTokens ?? resolveMaxOutputTokens()`）に揃えた。
   */
  test("出力の見込みが渡されなければ、設定値（16,384）で数える", async () => {
    let called = 0;
    // 入力＋8,192なら入るが、入力＋16,384では超える大きさにする
    const inputTokens = tokensFor(1000 + 20000);
    const wrapped = new MeteredProvider(
      provider({
        contextWindow: inputTokens + OUTPUT_RESERVE_TOKENS + 1000,
        onGenerate: () => called++,
      })
    );

    await expect(wrapped.generate(params(20000))).rejects.toMatchObject({
      kind: "context_overflow",
    });
    expect(called).toBe(0);
  });

  test("作者が設定を小さくすれば、関所の見込みもそれに従う", async () => {
    // 新しい定数を置いたのではなく、**実送信と同じ設定**を読んでいることの
    // 裏取り。定数を置き換えただけなら、設定を変えても結果は変わらない
    let called = 0;
    const inputTokens = tokensFor(1000 + 20000);
    const wrapped = new MeteredProvider(
      provider({
        contextWindow: inputTokens + OUTPUT_RESERVE_TOKENS + 1000,
        onGenerate: () => called++,
      })
    );

    const original = workspace.getConfiguration;
    workspace.getConfiguration = (() => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key === "maxOutputTokens" ? 2000 : defaultValue) as T,
    })) as typeof workspace.getConfiguration;
    try {
      await wrapped.generate(params(20000));
    } finally {
      // 作り物はテストファイル間で共有される。戻さないと後続へ漏れる
      workspace.getConfiguration = original;
    }

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

    // 渡された値が小さければ、既定（設定値16,384）ではなくそちらで判断する
    await wrapped.generate({ ...params(20000), maxOutputTokens: 8192 });
    expect(called).toBe(1);

    await expect(
      wrapped.generate({ ...params(20000), maxOutputTokens: 32768 })
    ).rejects.toMatchObject({ kind: "context_overflow" });
    expect(called).toBe(1);
  });

  /**
   * 見る順番は **実上限 → 見込み → 設定値**（設計書6.77の第2段）。
   *
   * 実上限が分かっているならそれが実際に送られる量なので、それで判断する。
   * 無ければ場所の確保に使う見込みを採り、どちらも無ければ実送信の既定
   * （設定値）に揃える。
   */
  test("実上限が渡されていれば、見込みより実上限で数える", async () => {
    let called = 0;
    const inputTokens = tokensFor(1000 + 20000);
    const wrapped = new MeteredProvider(
      provider({
        contextWindow: inputTokens + OUTPUT_RESERVE_TOKENS + 1000,
        onGenerate: () => called++,
      })
    );

    // 見込みは入る大きさだが、実際に送られるのは入らない大きさ
    await expect(
      wrapped.generate({
        ...params(20000),
        maxOutputTokens: 32768,
        plannedOutputTokens: 4096,
      })
    ).rejects.toMatchObject({ kind: "context_overflow" });
    expect(called).toBe(0);
  });

  test("実上限が無ければ、見込みで数える", async () => {
    let called = 0;
    const inputTokens = tokensFor(1000 + 20000);
    const wrapped = new MeteredProvider(
      provider({
        contextWindow: inputTokens + OUTPUT_RESERVE_TOKENS + 1000,
        onGenerate: () => called++,
      })
    );

    // 見込みが無ければ設定値（16,384）で数えて断るところを、
    // 見込み（4,096）が渡されているので通る
    await wrapped.generate({ ...params(20000), plannedOutputTokens: 4096 });
    expect(called).toBe(1);
  });

  /**
   * **上限を掛けないプロバイダでは、見込みのほうで数える**（設計書6.77の
   * 第2段。`AIProvider.capsOutput`）。
   *
   * 向きが逆なのには理由がある。**実際に場所を食うものが違う。**
   * クラウドは渡した上限をそのまま送るので、上限ぶんの席を空けておく
   * 必要がある。Ollamaは上限を送らない（設計書6.58.2）代わりに
   * `num_ctx` を見込みぶんだけ確保するので、**実際に消費されるのは
   * 見込みのほう**である。ここを実上限で見ると、32kのモデルで
   * 「確保は足りているのに関所が断る」ことになる。
   *
   * **プロバイダIDでは分岐しない。** LM Studio のようにOllama互換の口を
   * 持つものがあり、名前は当てにならない。
   */
  describe("上限を掛けないプロバイダ（設計書6.77）", () => {
    /** 32kのモデル相当。見込み8,192なら入るが、実上限16,384では入らない */
    const inputTokens = tokensFor(1000 + 20000);
    const contextWindow = inputTokens + OUTPUT_RESERVE_TOKENS + 1000;

    function sized(options: {
      capsOutput?: boolean;
      onGenerate: () => void;
    }): AIProvider {
      const base = provider({ contextWindow, onGenerate: options.onGenerate });
      return options.capsOutput === undefined
        ? base
        : { ...base, capsOutput: options.capsOutput };
    }

    const both = {
      maxOutputTokens: 16384,
      plannedOutputTokens: OUTPUT_RESERVE_TOKENS,
    };

    test("上限を掛けないプロバイダは、見込みで数えるので通る", async () => {
      let called = 0;
      const wrapped = new MeteredProvider(
        sized({ capsOutput: false, onGenerate: () => called++ })
      );

      await wrapped.generate({ ...params(20000), ...both });
      expect(called).toBe(1);
    });

    test("上限を掛けるプロバイダは、実上限で数えるので断る", async () => {
      let called = 0;
      const wrapped = new MeteredProvider(
        sized({ capsOutput: true, onGenerate: () => called++ })
      );

      await expect(
        wrapped.generate({ ...params(20000), ...both })
      ).rejects.toMatchObject({ kind: "context_overflow" });
      expect(called).toBe(0);
    });

    test("印を持たないプロバイダは、上限を掛ける側として扱う", async () => {
      // **安全側に倒す。** 印の付け忘れで「実際より小さく見積もって送る」
      // ほうへ倒れると、黙って切り捨てられる経路が復活する
      let called = 0;
      const wrapped = new MeteredProvider(sized({ onGenerate: () => called++ }));

      await expect(
        wrapped.generate({ ...params(20000), ...both })
      ).rejects.toMatchObject({ kind: "context_overflow" });
      expect(called).toBe(0);
    });

    test("上限を掛けないプロバイダでも、見込みが無ければ実上限で数える", async () => {
      // 見込みを渡してこない呼び出し（独り言など）まで甘くはしない
      let called = 0;
      const wrapped = new MeteredProvider(
        sized({ capsOutput: false, onGenerate: () => called++ })
      );

      await expect(
        wrapped.generate({ ...params(20000), maxOutputTokens: 16384 })
      ).rejects.toMatchObject({ kind: "context_overflow" });
      expect(called).toBe(0);
    });
  });

  describe("素通りする例外は1つだけ（設計書6.27.11）", () => {
    test("読める長さの測定は、上限を超えていても送る", async () => {
      // 申告値で止めると、申告どおりの長さまでしか試せず、
      // 「申告が本当か」を確かめるという目的そのものが果たせない
      let called = 0;
      const wrapped = new MeteredProvider(
        provider({ contextWindow: 8192, onGenerate: () => called++ })
      );

      await wrapped.generate({
        ...params(120000),
        meta: { feature: CONTEXT_GUARD_EXEMPT_FEATURE },
      });
      expect(called).toBe(1);
    });

    test("ほかの機能は、名前が似ていても止まる", async () => {
      let called = 0;
      const wrapped = new MeteredProvider(
        provider({ contextWindow: 32768, onGenerate: () => called++ })
      );

      for (const feature of ["extract", "typo", "context_probe_2", "probe"]) {
        await expect(
          wrapped.generate({ ...params(40000), meta: { feature } })
        ).rejects.toMatchObject({ kind: "context_overflow" });
      }
      expect(called).toBe(0);
    });

    test("機能名が無い呼び出しも止まる", async () => {
      let called = 0;
      const wrapped = new MeteredProvider(
        provider({ contextWindow: 32768, onGenerate: () => called++ })
      );

      await expect(wrapped.generate(params(40000))).rejects.toMatchObject({
        kind: "context_overflow",
      });
      expect(called).toBe(0);
    });

    test("素通りしてよいのは、この1つだけ", () => {
      // 例外が増えると「入らないものを黙って送る」経路が復活する。
      // 増やすときは、ここも一緒に考え直すことになる
      expect(skipsContextGuard(CONTEXT_GUARD_EXEMPT_FEATURE)).toBe(true);
      expect(skipsContextGuard(undefined)).toBe(false);
      expect(skipsContextGuard("")).toBe(false);
      expect(CONTEXT_GUARD_EXEMPT_FEATURE).toBe("context_probe");
    });
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

/**
 * 進むほど肥える設定資料（設計書6.27.10）。**2026-09-19の実機で起きた形**を
 * そのまま置く。
 *
 * 5話・11,714字の作品を、さくらのAI（上限32,000トークン）で設定資料の抽出に
 * かけたところ、**最後のチャンクだけ**が約32,342トークンになって落ちた。
 * 342トークン——たった1%——の超過である。
 *
 * チャンクを切った時点では資料が空なので、計画は「入る」と見ていた。
 * 抽出が進むと【既知の登場人物】【既知の能力】…が育ち、送る直前には
 * 入らなくなる。**そこまでは設計どおりで、関所が正しく断った。**
 * 問題はその先で、逃げ道（`chunkRetry.ts`）が「1,500字より小さくは
 * 割らない」という底に当たって**割り直さずにそのチャンクを失った**
 * ——最後の1話は2,343字しかなく、半分に割ると1,171字だったからである。
 *
 * **本文が小さいのに入らないのは、本文のせいではない。** 「このモデルでは
 * 扱えない」と言うのは嘘であり、240字ぶん減らせば入ることは数字で分かる。
 */
describe("資料が肥えて上限を越えたとき（2026-09-19の実機）", () => {
  /**
   * 実機の数字。
   *
   * 指示（system 792字＋P-04a 7,503字）＋既知の資料 約919字＋
   * 本文2,343字＝合わせて 11,170字。出力の見込みは設定値の16,384トークン。
   */
  const FIELD = {
    systemChars: 792,
    userChars: 10_378,
    outputTokens: 16_384,
    contextWindow: 32_000,
  };

  /** 実機で落ちた、最後に1話だけ残ったチャンク（2,343字・まとめていない） */
  function lastEpisode(): Chunk {
    const text = `${"あ".repeat(1171)}\n\n${"い".repeat(1170)}`;
    return {
      filePath: "005.txt",
      index: 0,
      text,
      startLine: 0,
      chapterStart: 5,
      chapterEnd: 5,
      hash: "episode-5",
      wholeFile: true,
    };
  }

  /** 実機と同じ断られ方をした失敗を作る */
  function fieldOverflow(): AIError {
    const error = contextOverflow(FIELD);
    if (!error) throw new Error("この数字は関所を通ってはいけない");
    return error;
  }

  test("実機と同じ数字で、関所が断る", () => {
    expect(fieldOverflow().message).toContain("32,342");
    expect(fieldOverflow().message).toContain("32,000");
  });

  test("下限より小さい本文でも、数字の裏付けがあれば割り直す", () => {
    // **これが失われた1チャンクである。** 底（1,500字）に当たって
    // 「このモデルには入りません」と言われ、第5話は誰にも読まれなかった
    const retry = retryOnOverflow(lastEpisode(), fieldOverflow());

    expect(retry.kind).toBe("split");
    if (retry.kind !== "split") return;
    expect(retry.parts).toHaveLength(2);
    // 本文は1文字も落とさない
    expect(retry.parts.map((part) => part.text).join("")).toBe(
      lastEpisode().text
    );
  });

  test("割った先は、ちゃんと入る大きさになっている", () => {
    const retry = retryOnOverflow(lastEpisode(), fieldOverflow());
    if (retry.kind !== "split") throw new Error("割られていない");

    // 資料の量（＝本文以外）は変わらないので、本文のぶんだけ引いて数え直す
    const others = FIELD.userChars - lastEpisode().text.length;
    for (const part of retry.parts) {
      expect(
        checkContextFit({ ...FIELD, userChars: others + part.text.length }).fits
      ).toBe(true);
    }
  });

  test("必要なところだけ縮める（痩せすぎない）", () => {
    // **片方だけを見ると、常に最小で送る実装が満点になる。**
    // 240字ぶん超えただけで下限まで刻むと、AIが一度に見る範囲が
    // 要らないところまで狭まり、出来ばえが落ちる（実機では、2つに
    // 割れたさくらが第5話で人物を取り違えた）
    const retry = retryOnOverflow(lastEpisode(), fieldOverflow());
    if (retry.kind !== "split") throw new Error("割られていない");

    expect(retry.parts).toHaveLength(2);
    for (const part of retry.parts) {
      expect(part.text.length).toBeGreaterThan(1000);
    }
  });

  test("資料が小さいうちは、これまでどおり1回で送れる", () => {
    // 資料が育つ前（＝抽出の1チャンク目）の形。ここで断られるようだと、
    // 「入らないから縮める」が常時発動していることになる
    const others = FIELD.userChars - lastEpisode().text.length - 900;
    expect(
      contextOverflow({
        ...FIELD,
        userChars: others + lastEpisode().text.length,
      })
    ).toBeUndefined();
    // 計画のほうも、資料が小さいうちは望んだ字数のまま縮めない
    expect(
      planChunkBudget({
        contextWindow: 32_000,
        overheadChars: 8_295,
        outputTokens: 8_192,
        requestedChars: 6_000,
      })
    ).toEqual({ chunkChars: 6_000, reason: "requested" });
  });

  test("本文を1文字も送れないなら、刻まずに諦めて理由を言う", () => {
    // 指示と資料だけで上限に届いている形。ここで割り続けても、
    // 入らない呼び出しの回数が増えるだけである
    const error = contextOverflow({ ...FIELD, userChars: 22_000 });
    if (!error) throw new Error("この数字は関所を通ってはいけない");
    const retry = retryOnOverflow(lastEpisode(), error);

    expect(retry.kind).toBe("give_up");
    // **本文のせいにしない。** 「本文を小さく分けて」とだけ言われた作者は、
    // 何度分けても直らない操作を繰り返すことになる
    expect(retry.note).toContain("指示と資料");
  });

  test("数字の裏付けが無い失敗では、これまでどおり下限で止まる", () => {
    // 内訳を持たない失敗で底を下げると、**入るかどうか分からないまま
    // 刻む**道ができる。降りてよいのは、入ると計算できたときだけである
    const retry = retryOnOverflow(
      lastEpisode(),
      new AIError("入りません", "context_overflow")
    );

    expect(retry.kind).toBe("give_up");
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

/**
 * 進捗とログに出す、チャンクの内訳（設計書6.27.10、実機確認リスト F-46）。
 *
 * **何を差し引いたかまで書く。** 設定に20,000字と書いたのに18,000字で
 * 動いていると、作者からは「設定が効いていない」ようにしか見えない。
 *
 * 進捗の帯が画面に出ること自体は実機に残る。ここで見るのは中身である。
 */
describe("1チャンクの内訳の書き方", () => {
  /** 差し引きのある、いちばん普通の形 */
  function settings(
    budget?: { chunkChars: number; reason: ChunkBudget["reason"]; overheadChars: number }
  ): ChunkSettings {
    return {
      mode: "auto",
      chunk: { chars: 18000, from: "model" },
      mergeChars: 0,
      ...(budget ? { budget } : {}),
    };
  }

  test("字数と、その根拠を書く（実機確認リスト F-46 の代わり）", () => {
    expect(describeChunkSettings(settings())).toContain(
      "1チャンク 18000字（モデルのコンテキスト長から）"
    );
  });

  test("指示と資料で何字を引いたかを書く（実機確認リスト F-46 の代わり）", () => {
    const text = describeChunkSettings(
      settings({ chunkChars: 18000, reason: "requested", overheadChars: 12000 })
    );

    expect(text).toContain("指示と資料 12000字を差し引き");
  });

  test("固定費に押されて縮めたときは、そう書く（実機確認リスト F-46 の代わり）", () => {
    const text = describeChunkSettings(
      settings({
        chunkChars: 18000,
        reason: "shrunk_to_fit",
        overheadChars: 12000,
      })
    );

    expect(text).toContain("（入るように縮めた）");
  });

  test("縮めても入らないときは、下限で送ると断る（実機確認リスト F-46 の代わり）", () => {
    // **黙って送らない。** 入らない見込みであることを先に言う
    const text = describeChunkSettings(
      settings({ chunkChars: 2000, reason: "minimum", overheadChars: 30000 })
    );

    expect(text).toContain("縮めても入り切らない見込み");
    expect(text).toContain("下限で送ります");
  });

  test("差し引く材料が無ければ、その部分は書かない（実機確認リスト F-46 の代わり）", () => {
    // 131,072のモデルでは溢れないので、差し引きの話そのものが要らない
    expect(describeChunkSettings(settings())).not.toContain("差し引き");
  });

  test("まとめ送信をするときは、その字数も並べる（実機確認リスト F-46 の代わり）", () => {
    const text = describeChunkSettings({
      ...settings(),
      mergeChars: 40000,
    });

    expect(text).toContain("まとめ送信 40000字");
  });
});

/**
 * 関所で止めた回も、送信量の記録に1行残す（実機確認リスト F-46）。
 *
 * **記録に何も出ないと、作者からは「押したのに何も起きなかった」としか
 * 見えない。** 送っていないので所要時間は0で残す。
 */
describe("関所で止めた回の記録", () => {
  test("送らなかった回も usage へ書く（実機確認リスト F-46 の代わり）", async () => {
    usageCalls.length = 0;

    const wrapped = new MeteredProvider({
      id: "ollama",
      displayName: "Ollama（ローカル）",
      isPaid: false,
      isConfigured: async () => true,
      testConnection: async () => ({ ok: true, message: "" }),
      listModels: async () => [],
      generate: async (): Promise<GenerateResult> => ({
        text: "{}",
        truncated: false,
        elapsedMs: 1,
      }),
      getModel: async (id: string): Promise<ModelInfo | undefined> => ({
        id,
        displayName: id,
        contextWindow: 8192,
        parameterSize: null,
        capabilities: [],
        tier: "standard",
      }),
    });

    await expect(
      wrapped.generate({
        systemPrompt: "あ".repeat(1000),
        userPrompt: "い".repeat(40000),
        model: "gemma4:e4b",
        temperature: 0,
        meta: { feature: "矛盾検知", workFolder: "C:/作品" },
      })
    ).rejects.toMatchObject({ kind: "context_overflow" });

    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0][0]).toBe("C:/作品");
    expect(usageCalls[0][1].feature).toBe("矛盾検知");
    // 何があったかも残す（「押したのに何も起きない」を作らない）
    expect(usageCalls[0][1].error).toBeTruthy();
    // 送っていないので、所要時間はAIの遅さとして数えない
    expect(usageCalls[0][1].elapsedMs).toBe(0);
  });
});

/**
 * **出力の見込みだけで、読める長さに届くモデル**（さくら llm-jp・Phi、
 * 比べ 2026-09-25〜26）。
 *
 * 4,096トークンしか読めないモデルへ、出力の上限 11,264 を送っていた。
 * 長さを正しく4,096と知っても、**関所は「入らない」と断り、逃げ道は本文を
 * 半分に割り続ける**——出力の見込みだけで上限を超えているので、本文を
 * いくら割っても入らない。10話すべてが失敗する形は変わらない。
 *
 * そのときに限って、**出力の上限を「読める長さ − 入力」まで縮めて送る。**
 * 4,096しか読めないモデルは、どう頼んでも 11,264 は書けないので、縮めて
 * 失うものは無い。見込みが上限に届いていないとき（ふつうの大きいモデル）は
 * 縮めない——そちらは本文を割るほうが、応答を切らずに済む。
 */
describe("出力の見込みだけで上限に届くモデル（さくら 2026-09-26）", () => {
  /** llm-jp の実測の字/トークン（2026-09-26、5回ぶんの最小値） */
  const LLM_JP = { charsPerToken: 1.712, charsPerTokenSamples: 5 };

  function small(onGenerate: (params: GenerateParams) => void): AIProvider {
    return {
      id: "sakura",
      displayName: "さくらのAI",
      isPaid: true,
      isConfigured: async () => true,
      testConnection: async () => ({ ok: true, message: "" }),
      listModels: async () => [],
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        onGenerate(params);
        return { text: "{}", truncated: false, elapsedMs: 1 };
      },
      getModel: async (id: string): Promise<ModelInfo | undefined> => ({
        id,
        displayName: id,
        contextWindow: 4096,
        parameterSize: null,
        capabilities: [],
        tier: "light",
      }),
    };
  }

  test("入力が入るなら、出力の上限を残りまで縮めて送る", async () => {
    const seen: GenerateParams[] = [];
    const wrapped = new MeteredProvider(small((p) => seen.push(p)));

    await wrapped.generate({
      systemPrompt: "あ".repeat(700),
      userPrompt: "い".repeat(700),
      // 同梱の字/トークンが無いモデル名にする（見積りを 0.7 に揃えるため）
      model: "まだ測っていない小さいモデル",
      temperature: 0,
      maxOutputTokens: 11264,
      plannedOutputTokens: 11264,
    });

    expect(seen).toHaveLength(1);
    const allowed = 4096 - tokensFor(1400);
    expect(seen[0].maxOutputTokens).toBe(allowed);
    expect(seen[0].plannedOutputTokens).toBe(allowed);
  });

  test("出力の上限が渡されなくても、縮めた値を明示して送る", async () => {
    // 渡されないとプロバイダは設定値（16,384）を送る。それでは同じ400になる
    const seen: GenerateParams[] = [];
    const wrapped = new MeteredProvider(small((p) => seen.push(p)));

    await wrapped.generate({
      systemPrompt: "あ".repeat(700),
      userPrompt: "い".repeat(700),
      // 同梱の字/トークンが無いモデル名にする（見積りを 0.7 に揃えるため）
      model: "まだ測っていない小さいモデル",
      temperature: 0,
    });

    expect(seen[0].maxOutputTokens).toBe(4096 - tokensFor(1400));
  });

  test("縮めると応答の床（1,024）を割るなら、これまでどおり入らないと断る", async () => {
    // 逃げ道（本文を割る）へ回す。床より小さい上限で送っても、応答は切れる
    let called = 0;
    const wrapped = new MeteredProvider(small(() => called++));

    await expect(
      wrapped.generate({
        systemPrompt: "あ".repeat(700),
        userPrompt: "い".repeat(1500),
        // 同梱の字/トークンが無いモデル名にする（見積りを 0.7 に揃えるため）
      model: "まだ測っていない小さいモデル",
        temperature: 0,
        maxOutputTokens: 11264,
      })
    ).rejects.toMatchObject({ kind: "context_overflow" });
    expect(called).toBe(0);
  });

  test("出力の見込みが上限に届いていなければ、縮めずに断る（本文を割る）", async () => {
    // 3,000 は 4,096 に届かない。入力を割れば入る形なので、応答を削らない
    let called = 0;
    const wrapped = new MeteredProvider(small(() => called++));

    await expect(
      wrapped.generate({
        systemPrompt: "あ".repeat(700),
        userPrompt: "い".repeat(700),
        // 同梱の字/トークンが無いモデル名にする（見積りを 0.7 に揃えるため）
      model: "まだ測っていない小さいモデル",
        temperature: 0,
        maxOutputTokens: 3000,
      })
    ).rejects.toMatchObject({ kind: "context_overflow" });
    expect(called).toBe(0);
  });

  test("チャンクの計画でも、出力の見込みは読める長さの半分までにする", () => {
    // 見込み 11,264 のまま差し引くと本文の割当が負になり、下限で止まる。
    // 関所は残りを出力へ回すので、計画も同じ考え方で本文へ場所を残す
    const capped = planChunkBudget({
      contextWindow: 4096,
      overheadChars: 500,
      measured: LLM_JP,
      outputTokens: 11264,
      requestedChars: 20000,
    });
    const halved = planChunkBudget({
      contextWindow: 4096,
      overheadChars: 500,
      measured: LLM_JP,
      outputTokens: 2048,
      requestedChars: 20000,
    });

    expect(capped).toEqual(halved);
    // 半分にしたぶん、本文の場所が空いている
    expect(capped.reason).not.toBe("minimum");
  });

  test("見込みが上限に届かないモデルの計画は、半分へ丸めない", () => {
    // 見込み 3,000 は 4,096 に届かないので、そのまま差し引く
    const asIs = planChunkBudget({
      contextWindow: 4096,
      overheadChars: 500,
      measured: LLM_JP,
      outputTokens: 3000,
      requestedChars: 20000,
    });
    const halved = planChunkBudget({
      contextWindow: 4096,
      overheadChars: 500,
      measured: LLM_JP,
      outputTokens: 2048,
      requestedChars: 20000,
    });

    expect(asIs.chunkChars).toBeLessThan(halved.chunkChars);
  });
});
