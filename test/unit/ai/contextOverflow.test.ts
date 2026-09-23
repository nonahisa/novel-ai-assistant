import { afterEach, describe, expect, test, vi } from "vitest";
import {
  asContextOverflowError,
  classifyContextOverflow,
  OpenAIProvider,
} from "../../src/ai/openaiProvider";
import { SakuraProvider } from "../../src/ai/sakuraProvider";
import { LmStudioProvider } from "../../src/ai/lmstudioProvider";
import { toStatusError } from "../../src/ai/httpClient";
import { AIError } from "../../src/ai/types";

/**
 * 上限を超えたときの400を「入らなかった」と分類する（作者のログ、
 * 2026-08-30、さくら gpt-oss-120b）。
 *
 * 実際に返ってきたのは次の本文で、これが `bad_response` に丸められて
 * いたため「AIが実際に読める長さを測る」がそこで打ち切られ、作者には
 * 「さくらもつながりません」と見えていた。
 *
 * > Input length (170068) exceeds model's maximum context length (131072).
 *
 * **`context_overflow` に分けると、話ごと→半分と刻み直す再試行
 * （`features/chunkRetry.ts`）も効くようになる。**
 */

/** 作者のログにあった本文そのもの */
const REAL_BODY = JSON.stringify({
  error: {
    message:
      "Input length (170068) exceeds model's maximum context length (131072).",
    type: "BadRequestError",
    code: 400,
  },
});

describe("上限超えの400を見分ける", () => {
  test.each([
    ["OpenAI/vLLM の定型文", "maximum context length is 131072 tokens"],
    ["エラーコード", '{"code":"context_length_exceeded"}'],
    ["さくらの実測の本文", REAL_BODY],
    ["トークン数の言い方", "This model has too many tokens in the request"],
    ["Anthropic系の言い方", "prompt is too long: 210000 tokens"],
  ])("%s は上限超えとして扱う", (_name, body) => {
    expect(classifyContextOverflow(400, body)).toBe(true);
  });

  /**
   * **ここを広げない。** CLAUDE.md 規則5「HTTP 400を『要求の形が悪い』と
   * 決めつけない」の裏返しで、上限超え以外の400まで拾うと、
   * 残高不足や指定の誤りを「本文を短くしてください」と案内してしまう。
   */
  test.each([
    ["残高不足", "insufficient credit for this request"],
    ["残高不足（OpenAIの符号）", '{"code":"insufficient_quota"}'],
    ["指定が未対応", "Unsupported parameter: 'temperature'"],
    ["モデル名の誤り", "The model `gpt-nope` does not exist"],
    ["空の本文", ""],
  ])("%s は上限超えにしない", (_name, body) => {
    expect(classifyContextOverflow(400, body)).toBe(false);
  });

  test("400以外は、本文が合っていても対象外", () => {
    // レート上限（429）や認証（401）は原因がまったく別である
    expect(classifyContextOverflow(429, REAL_BODY)).toBe(false);
    expect(classifyContextOverflow(401, REAL_BODY)).toBe(false);
    expect(classifyContextOverflow(500, REAL_BODY)).toBe(false);
  });
});

/**
 * `httpClient` が組み立てた失敗から種別を付け替える。
 *
 * **本物の `toStatusError` を通す。** 状態番号は `AIError` に入っていないので
 * 通知文の「(HTTP 400)」から読んでおり、`httpClient` 側の文言が変われば
 * 静かに効かなくなる。ここで通しておけば、そのとき落ちる。
 */
describe("HTTPの失敗を context_overflow へ付け替える", () => {
  test("さくらの400は上限超えとして扱う", () => {
    const original = toStatusError(400, REAL_BODY, "さくらのAI Engine");
    expect(original.kind).toBe("bad_response");

    const converted = asContextOverflowError(original, "さくらのAI Engine");

    expect(converted?.kind).toBe("context_overflow");
    expect(converted?.message).toContain("さくらのAI Engine");
    // 実際の長さと上限は本文にしかない。捨てない
    expect(converted?.detail).toContain("170068");
  });

  test("ChatGPTの400も同じように扱う", () => {
    const original = toStatusError(
      400,
      '{"error":{"code":"context_length_exceeded"}}',
      "ChatGPT"
    );

    expect(asContextOverflowError(original, "ChatGPT")?.kind).toBe(
      "context_overflow"
    );
  });

  test("残高不足の400は bad_response のままにする", () => {
    const original = toStatusError(
      400,
      '{"error":{"message":"insufficient credit"}}',
      "さくらのAI Engine"
    );

    expect(asContextOverflowError(original, "さくらのAI Engine")).toBeUndefined();
    expect(original.kind).toBe("bad_response");
  });

  test("429は本文が合っていても付け替えない", () => {
    // レート上限は待てば回復する。「本文を短くしてください」は的外れ
    const original = toStatusError(429, REAL_BODY, "さくらのAI Engine");

    expect(original.kind).toBe("rate_limited");
    expect(asContextOverflowError(original, "さくらのAI Engine")).toBeUndefined();
  });

  test("HTTPの失敗でないものは触らない", () => {
    const notHttp = new AIError("AIから空の応答が返りました。", "bad_response");

    expect(asContextOverflowError(notHttp, "ChatGPT")).toBeUndefined();
    expect(asContextOverflowError(new Error("ふつうの例外"), "ChatGPT")).toBeUndefined();
  });
});

/**
 * プロバイダの `generate` まで通して確かめる。
 *
 * **純粋関数だけを試しても、呼び忘れには気づけない。** 実際に落ちたのは
 * `generate` の再試行の枝であり、そこから呼ばれていることを固定する。
 */
describe("プロバイダが返す失敗の種別", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** どのURLを叩かれても、400と本文を返す */
  function stubFetch(body: string, status = 400): void {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(body, {
          status,
          headers: { "Content-Type": "application/json" },
        })
    );
  }

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

  const params = {
    systemPrompt: "指示",
    userPrompt: "本文",
    model: "gpt-oss-120b",
    temperature: 0,
  };

  test("さくら：上限超えは context_overflow で返る", async () => {
    stubFetch(REAL_BODY);
    const provider = new SakuraProvider(fakeContext());

    await expect(provider.generate(params)).rejects.toMatchObject({
      kind: "context_overflow",
    });
  });

  test("ChatGPT：上限超えは context_overflow で返る", async () => {
    stubFetch(REAL_BODY);
    const provider = new OpenAIProvider(fakeContext());

    await expect(provider.generate(params)).rejects.toMatchObject({
      kind: "context_overflow",
    });
  });

  test("LM Studio：上限超えは context_overflow で返る", async () => {
    // 読み込んだ文脈の長さを超えたときも400で返る
    stubFetch(REAL_BODY);
    const provider = new LmStudioProvider();

    await expect(provider.generate(params)).rejects.toMatchObject({
      kind: "context_overflow",
    });
  });

  test("さくら：残高不足の400は bad_response のまま", async () => {
    // ここを取り違えると、払えば済む話を「本文を短く」と案内してしまう
    stubFetch('{"error":{"message":"insufficient credit"}}');
    const provider = new SakuraProvider(fakeContext());

    await expect(provider.generate(params)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });
});
