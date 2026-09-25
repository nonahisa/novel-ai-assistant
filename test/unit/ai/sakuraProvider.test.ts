import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "../support/vscodeStub";
import {
  SakuraProvider,
  SAKURA_CONTEXT_WINDOW,
  parseParameterSize,
} from "../../../src/ai/sakuraProvider";
import { inferTier, type GenerateParams } from "../../../src/ai/types";

/**
 * さくらのAI Engine アダプタ。
 *
 * APIはOpenAI互換なので、`generate` や `listModels` の道は ChatGPT と同じ
 * 部品（`fetchJson` / `isChatModel` / `isUnsupportedParameter`）を使い回す。
 * **ここで確かめるのは、さくらに固有の判断のほうである。**
 */
describe("モデル名からパラメータ数を読む", () => {
  test.each([
    ["preview/gemma-4-31B-it", "31B"],
    ["gemma-4-9b-it", "9B"],
    ["llama-3.3-70B-instruct", "70B"],
    ["some-model-1.5B", "1.5B"],
  ])("%s → %s", (id, expected) => {
    expect(parseParameterSize(id)).toBe(expected);
  });

  test.each([
    // 大きさが名前に無いもの
    "preview/some-model-it",
    "gpt-4o",
    "",
  ])("読めなければ null: %s", (id) => {
    expect(parseParameterSize(id)).toBeNull();
  });

  test("版番号を大きさと読み違えない", () => {
    // 「llama-3.3」の 3.3 はパラメータ数ではない。
    // B か M が続くものだけを拾う
    expect(parseParameterSize("llama-3.3-instruct")).toBeNull();
  });
});

/**
 * **「クラウドだから最上位」と決めつけない。**
 *
 * さくらが出しているのは公開重みのモデルで、名前に大きさが入っている。
 * 中身が非公開の Claude や ChatGPT とは事情が違う。
 *
 * ここを最上位にすると、31Bのモデルへ 70B級を想定した長さのプロンプトと
 * チャンクが渡る。**手元の12Bで駄目だった仕事を投げることになる。**
 */
describe("大きさに見合った扱いにする", () => {
  test("31Bは最上位として扱う", () => {
    expect(inferTier(parseParameterSize("preview/gemma-4-31B-it"), "ollama")).toBe(
      "high"
    );
  });

  test("9Bは中位として扱う", () => {
    expect(inferTier(parseParameterSize("gemma-4-9b-it"), "ollama")).toBe(
      "standard"
    );
  });

  test("小さいモデルは軽い扱いにする", () => {
    expect(inferTier(parseParameterSize("some-model-3B"), "ollama")).toBe(
      "light"
    );
  });

  test("大きさが分からなければ、控えめに見る", () => {
    // **分からないものを最上位にしない。** 重い仕事を投げて失敗するより、
    // 軽い扱いで確実に返るほうがよい
    expect(inferTier(parseParameterSize("preview/unknown-it"), "ollama")).toBe(
      "light"
    );
  });

  test("他のクラウドは今までどおり最上位", () => {
    // さくらの扱いを変えたことで、ChatGPTやClaudeが巻き込まれていないか
    expect(inferTier(null, "openai")).toBe("high");
    expect(inferTier(null, "claude")).toBe("high");
    expect(inferTier(null, "gemini")).toBe("high");
  });
});

/* ────────────────────────────────────────────────────────────
   ここから下は、誤字脱字検知の比べ（2026-09-25〜26）で見つかった
   さくらの接続の不具合の再現と、その直しの固定である。
   ──────────────────────────────────────────────────────────── */

/** APIキーを持っているふりをする。資格情報ストアは使わない */
function fakeContext(): ConstructorParameters<typeof SakuraProvider>[0] {
  return {
    secrets: {
      get: async () => "test-api-key-0123456789",
      store: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as ConstructorParameters<typeof SakuraProvider>[0];
}

/** 送られた本文を控えつつ、順に用意した応答を返す */
function stubFetchSequence(
  responses: Array<{ status: number; body: unknown }>
): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  let index = 0;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return sent;
}

function okBody(content: string | null, finishReason = "stop"): unknown {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

/** 思考を止める指定以外で断られたときの本文（中身は問わない） */
const REJECTED = { error: { message: "Bad Request", code: 400 } };

function params(overrides: Partial<GenerateParams> = {}): GenerateParams {
  return {
    systemPrompt: "指示",
    userPrompt: "本文",
    model: "preview/Qwen3.6-35B-A3B",
    temperature: 0,
    ...overrides,
  };
}

describe("考えるタイプのモデルの思考を止める（比べ 2026-09-25〜26）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * **再現**：Qwen3.6-35B-A3B・Kimi-K2.7-Code・Kimi-K2.6 が、考える途中で
   * 出力の上限（11,264）を使い切り、応答が空（finish_reason=length）になった。
   * Ollama へは `think: false` を送っているのに、さくらへは何も送っていなかった。
   *
   * 実測（2026-09-26）で効いたのは、OpenAI互換の口の `chat_template_kwargs`
   * ——Qwen 系は `enable_thinking`、Kimi 系は `thinking` を読む。
   * **モデル名で分けずに両方を送る**（テンプレートは知らない鍵を読まない）。
   */
  test("思考を切る呼び出しでは、思考を止める指定を送る", async () => {
    const sent = stubFetchSequence([{ status: 200, body: okBody("{}") }]);
    const provider = new SakuraProvider(fakeContext());

    await provider.generate(params({ disableThinking: true }));

    expect(sent[0].chat_template_kwargs).toEqual({
      enable_thinking: false,
      thinking: false,
    });
  });

  test("思考を切らない呼び出しには、何も足さない", async () => {
    const sent = stubFetchSequence([{ status: 200, body: okBody("{}") }]);
    const provider = new SakuraProvider(fakeContext());

    await provider.generate(params());

    expect(sent[0].chat_template_kwargs).toBeUndefined();
  });

  /**
   * **`reasoning_effort` は送らない。** 実測で Kimi-K2.6 に `none` を送ると、
   * 考えた文がそのまま本文（content）へ流れ出て、JSONの前に独り言が付いた。
   */
  test("推論の深さの指定（reasoning_effort）は送らない", async () => {
    const sent = stubFetchSequence([{ status: 200, body: okBody("{}") }]);
    const provider = new SakuraProvider(fakeContext());

    await provider.generate(params({ disableThinking: true }));

    expect(sent[0].reasoning_effort).toBeUndefined();
  });

  /**
   * **断られたら外して出し直す**（CLAUDE.md 規則5）。どの指定が悪いのかを
   * エラー文から当てにいかず、任意の指定を外して試す。
   */
  test("断られたら、思考を止める指定を外して出し直す", async () => {
    const sent = stubFetchSequence([
      { status: 400, body: REJECTED },
      { status: 200, body: okBody("{}") },
    ]);
    const provider = new SakuraProvider(fakeContext());

    const result = await provider.generate(params({ disableThinking: true }));

    expect(result.text).toBe("{}");
    expect(sent).toHaveLength(2);
    expect(sent[0].chat_template_kwargs).toBeDefined();
    expect(sent[1].chat_template_kwargs).toBeUndefined();
  });

  test("外して通ったモデルは、次から最初から外す（覚えるのは通ったときだけ）", async () => {
    const sent = stubFetchSequence([
      { status: 400, body: REJECTED },
      { status: 200, body: okBody("{}") },
      { status: 200, body: okBody("{}") },
    ]);
    const provider = new SakuraProvider(fakeContext());

    await provider.generate(params({ disableThinking: true }));
    await provider.generate(params({ disableThinking: true }));

    // 2回目の呼び出しは1回で通る（むだな400をもらわない）
    expect(sent).toHaveLength(3);
    expect(sent[2].chat_template_kwargs).toBeUndefined();
  });

  /**
   * **失敗から学習しない。** 残高不足のように、外しても直らない400で
   * 覚え込むと、原因が別だったのに思考を止める手段を永久に失う
   * （Claude で実際に起きた）。
   */
  test("外しても通らなかったときは、覚えない", async () => {
    const sent = stubFetchSequence([
      { status: 400, body: REJECTED },
      { status: 400, body: REJECTED },
      { status: 200, body: okBody("{}") },
    ]);
    const provider = new SakuraProvider(fakeContext());

    await expect(
      provider.generate(params({ disableThinking: true }))
    ).rejects.toMatchObject({ kind: "bad_response" });
    await provider.generate(params({ disableThinking: true }));

    // 次の呼び出しは、また思考を止める指定を付けて始める
    expect(sent[2].chat_template_kwargs).toBeDefined();
  });

  test("外して通ったのは、そのモデルだけ（ほかのモデルは付けたまま）", async () => {
    const sent = stubFetchSequence([
      { status: 400, body: REJECTED },
      { status: 200, body: okBody("{}") },
      { status: 200, body: okBody("{}") },
    ]);
    const provider = new SakuraProvider(fakeContext());

    await provider.generate(params({ disableThinking: true }));
    await provider.generate(
      params({ disableThinking: true, model: "preview/Kimi-K2.6" })
    );

    expect(sent[2].chat_template_kwargs).toBeDefined();
  });

  /**
   * 空の応答のうち、**上限で切られた空**は直し方が違う。「AIから空の応答が
   * 返りました」だけでは、作者は何をすればよいか分からない。
   */
  test("出力の上限で切られて空だったときは、そう言う", async () => {
    stubFetchSequence([{ status: 200, body: okBody(null, "length") }]);
    const provider = new SakuraProvider(fakeContext());

    await expect(provider.generate(params())).rejects.toMatchObject({
      kind: "bad_response",
      message: expect.stringContaining("上限"),
    });
  });
});

/**
 * **再現**：llm-jp-3.1-8x13b-instruct4 と Phi-4-mini-instruct-cpu は4,096しか
 * 読めないのに、どのモデルも既定の32,000として扱っていたため、出力の上限
 * 11,264 を送って10話すべて HTTP 400 になった。
 *
 * さくらのモデル一覧（`/v1/models`）も個別の口（`/v1/models/{id}` は404）も
 * 長さを教えない（2026-09-26 に確かめた）。長さはサーバー自身の400の本文
 * （「maximum context length is 4096 tokens」「max_model_len=4096」）にだけ
 * 書かれていたので、同梱の初期値として持つ（`core/bundledTuning.ts`）。
 */
describe("読める長さが短いモデル（比べ 2026-09-25〜26）", () => {
  /**
   * 本物の VS Code と同じく、**作者が書いていない設定は「書いていない」と
   * 答える**形にする。代役の既定（`get` だけ）では既定値が「書いた値」に
   * 見え、同梱より先に 32,000 が勝ってしまう。
   */
  const original = workspace.getConfiguration;
  beforeEach(() => {
    workspace.getConfiguration = (() => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
      inspect: () => ({ workspaceValue: undefined }),
    })) as unknown as typeof workspace.getConfiguration;
  });
  afterEach(() => {
    workspace.getConfiguration = original;
  });

  test.each([
    ["llm-jp-3.1-8x13b-instruct4", 4096],
    ["preview/Phi-4-mini-instruct-cpu", 4096],
  ])("%s は %d トークンとして扱う", async (model, expected) => {
    const provider = new SakuraProvider(fakeContext());

    expect((await provider.getModel(model))?.contextWindow).toBe(expected);
  });

  test("長さを持っていないモデルは、これまでどおり既定で扱う", async () => {
    const provider = new SakuraProvider(fakeContext());

    expect((await provider.getModel("preview/Qwen3.6-35B-A3B"))?.contextWindow).toBe(
      SAKURA_CONTEXT_WINDOW.fallback
    );
  });
});

/**
 * **再現**：さくらのモデル一覧に、埋め込み用の `multilingual-e5-large` が
 * 混ざり、機能別AI割当などで選べてしまっていた。文章を書かせても返らない。
 * 埋め込み（意味検索）は Ollama だけで行うので、さくら側で残す理由は無い。
 */
describe("モデル一覧から、会話に使えないモデルを外す", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 2026-09-26 に実際に返った一覧（`created` は省いた） */
  const REAL_LIST = {
    object: "list",
    data: [
      "multilingual-e5-large",
      "preview/Kimi-K2.7-Code",
      "preview/Qwen3-0.6B-cpu",
      "preview/Phi-4-mini-instruct-cpu",
      "preview/Qwen3-Embedding-4B-FP16",
      "preview/Kimi-K2.6",
      "preview/gemma-4-31B-it",
      "preview/Qwen3.6-35B-A3B",
      "llm-jp-3.1-8x13b-instruct4",
      "whisper-large-v3-turbo",
      "preview/Qwen3-VL-30B-A3B-Instruct",
      "gpt-oss-120b",
    ].map((id) => ({ id, object: "model", owned_by: "sakura" })),
  };

  test("埋め込み用・音声用を一覧に出さない", async () => {
    stubFetchSequence([{ status: 200, body: REAL_LIST }]);
    const provider = new SakuraProvider(fakeContext());

    const ids = (await provider.listModels()).map((model) => model.id);

    expect(ids).not.toContain("multilingual-e5-large");
    expect(ids).not.toContain("preview/Qwen3-Embedding-4B-FP16");
    expect(ids).not.toContain("whisper-large-v3-turbo");
    // 会話に使えるものは、候補から外すと決めた2つ（下の試験）のほかは落とさない
    expect([...ids].sort()).toEqual(
      [
        "gpt-oss-120b",
        "preview/Kimi-K2.6",
        "preview/Kimi-K2.7-Code",
        "preview/Phi-4-mini-instruct-cpu",
        "preview/Qwen3-VL-30B-A3B-Instruct",
        "preview/Qwen3.6-35B-A3B",
        "preview/gemma-4-31B-it",
      ].sort()
    );
  });

  /*
    **再現**（作者の裁定 2026-09-26 深夜）：誤字脱字検知の比べで、llm-jp と
    Qwen3-0.6B は確実な誤り19件を1件も拾わなかった（llm-jp は指示の言葉を
    そのまま返した）。一覧に出ていると機能別AI割当などで選べてしまう。
    **一覧から外すだけで、名前を指定すれば使える**形は残す
  */
  test("仕事をこなせないと測った2つを候補に出さない。名前を指定すれば使える", async () => {
    stubFetchSequence([{ status: 200, body: REAL_LIST }]);
    const provider = new SakuraProvider(fakeContext());

    const ids = (await provider.listModels()).map((model) => model.id);
    expect(ids).not.toContain("llm-jp-3.1-8x13b-instruct4");
    expect(ids).not.toContain("preview/Qwen3-0.6B-cpu");

    // 選ぶ画面で名前を打った・前から割り当ててある、の道は閉じない
    const named = await provider.getModel("llm-jp-3.1-8x13b-instruct4");
    expect(named?.id).toBe("llm-jp-3.1-8x13b-instruct4");
    expect((await provider.getModel("preview/Qwen3-0.6B-cpu"))?.id).toBe(
      "preview/Qwen3-0.6B-cpu"
    );
  });
});
