import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "../support/sweepTimeout";
import { LmStudioProvider } from "../../../src/ai/lmstudioProvider";
import { AIError } from "../../../src/ai/types";
import { workspace } from "../support/vscodeStub";
import { jsonResponse } from "../support/aiResponses";

/**
 * llama.cpp の server（llama-server）を LM Studio の欄でつなぐ（作者の決定 2026-11-23）。
 *
 * 応答の形は llama-server b12647（gemma4:26b、`--alias gemma4:26b -c 8192`）を
 * 実際に叩いて写したもの。
 */

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

/** コンテキスト長の設定だけを差し替える（ほかは既定のまま） */
function stubContextWindowSetting(value: number): void {
  workspace.getConfiguration = () => ({
    get: <T>(key: string, defaultValue: T): T =>
      key === "lmstudio.contextWindow" ? (value as T) : defaultValue,
  });
}

const chatOk = {
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 3 },
};

const params = {
  systemPrompt: "system",
  userPrompt: "user",
  model: "gemma4:26b",
  temperature: 0.2,
};

beforeEach(() => {
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("思考を切る指定（chat_template_kwargs）", () => {
  function stubChat(
    respond: (body: Record<string, unknown>) => Response
  ): Record<string, unknown>[] {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return respond(body);
      })
    );
    return bodies;
  }

  test("disableThinking のとき、enable_thinking: false を送る", async () => {
    const bodies = stubChat(() => jsonResponse(chatOk));

    await new LmStudioProvider().generate({ ...params, disableThinking: true });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test("disableThinking が無いときは送らない", async () => {
    const bodies = stubChat(() => jsonResponse(chatOk));

    await new LmStudioProvider().generate(params);

    expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
  });

  test("断られたら外して送り直す", async () => {
    const bodies = stubChat((body) =>
      body.chat_template_kwargs !== undefined
        ? jsonResponse(
            { error: { message: "chat_template_kwargs is not supported" } },
            400
          )
        : jsonResponse(chatOk)
    );

    const result = await new LmStudioProvider().generate({
      ...params,
      disableThinking: true,
    });

    expect(result.text).toBe('{"ok":true}');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("chat_template_kwargs");
  });

  test("外す指定が3つとも断られても、4回目で通る", async () => {
    // 上限が3回のままだと、3つ外したところで送り直せずに終わる
    const bodies = stubChat((body) => {
      for (const key of ["response_format", "temperature", "chat_template_kwargs"]) {
        if (body[key] !== undefined) {
          return jsonResponse(
            { error: { message: `${key} is not supported` } },
            400
          );
        }
      }
      return jsonResponse(chatOk);
    });

    const result = await new LmStudioProvider().generate({
      ...params,
      disableThinking: true,
      jsonSchema: { type: "object", properties: {} },
    });

    expect(result.text).toBe('{"ok":true}');
    expect(bodies).toHaveLength(4);
  });

  test("断られた理由が違えば外さずに失敗を返す", async () => {
    // エラー文から原因を当てない。未対応と言われていないものは外さない
    const bodies = stubChat(() =>
      jsonResponse({ error: { message: "Invalid 'messages'." } }, 400)
    );

    const error = await new LmStudioProvider()
      .generate({ ...params, disableThinking: true })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIError);
    expect(bodies).toHaveLength(1);
  });
});

describe("llama-server の大きさと文脈長", () => {
  /** llama-server b12647 の `/v1/models` の1件 */
  const llamaModel = {
    id: "gemma4:26b",
    object: "model",
    meta: {
      vocab_type: 2,
      n_vocab: 262144,
      n_ctx: 8192,
      n_ctx_train: 262144,
      n_embd: 2816,
      n_params: 25233142046,
      size: 16931716216,
      ftype: "Q4_K - Medium",
    },
  };

  interface Stub {
    native?: unknown[];
    models: unknown[];
    props?: unknown;
  }

  function stubServer(stub: Stub): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = urlOf(input);
        urls.push(url);
        if (url.endsWith("/api/v0/models")) {
          return stub.native === undefined
            ? jsonResponse(
                {
                  error: {
                    message: "File Not Found",
                    type: "not_found_error",
                    code: 404,
                  },
                },
                404
              )
            : jsonResponse({ data: stub.native });
        }
        if (url.endsWith("/props")) {
          return stub.props === undefined
            ? jsonResponse({ error: "Unexpected endpoint" }, 404)
            : jsonResponse(stub.props);
        }
        return jsonResponse({ data: stub.models });
      })
    );
    return urls;
  }

  test("/api/v0/models が404なら、meta の大きさと /props の長さを使う", async () => {
    stubContextWindowSetting(4096);
    // スロットあたりの長さ（--parallel で割られる）が meta の n_ctx より短い場合
    stubServer({
      models: [llamaModel],
      props: {
        default_generation_settings: { n_ctx: 6144 },
        model_alias: "gemma4:26b",
      },
    });

    const provider = new LmStudioProvider();
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0].parameterSize).toBe("25.2B");
    // 小さいモデル向けの頼み方にならない（大きさの表記を能力の見積もりが読める）
    expect(models[0].tier).not.toBe("light");
    // 読み込み済みとして返す。最大が無いので、LM Studio の口で読み直しに行かない
    expect(await provider.readModelLoadState("gemma4:26b")).toEqual({
      loaded: true,
      maxContextLength: undefined,
      loadedContextLength: 6144,
    });
    // 設定値（4096）にも meta の n_ctx（8192）にも勝つ
    expect(models[0].contextWindow).toBe(6144);
    // n_ctx_train（262144）は使わない
    expect(models[0].contextWindow).not.toBe(262144);
    expect((await provider.getModel("gemma4:26b"))?.contextWindow).toBe(6144);
  });

  test("/props が読めなければ meta の n_ctx を使う", async () => {
    stubContextWindowSetting(4096);
    stubServer({ models: [llamaModel] });

    const models = await new LmStudioProvider().listModels();

    expect(models[0].contextWindow).toBe(8192);
    expect(models[0].parameterSize).toBe("25.2B");
  });

  test("名前から大きさが読めない（gguf の絶対パス）ときも n_params で読む", async () => {
    const pathId = "C:\\models\\gemma-4-26b-a4b-it-Q4_K_M.gguf";
    stubServer({
      models: [{ ...llamaModel, id: pathId }],
      props: { default_generation_settings: { n_ctx: 8192 } },
    });

    const models = await new LmStudioProvider().listModels();

    expect(models[0].parameterSize).toBe("25.2B");
    expect(models[0].contextWindow).toBe(8192);
  });

  test("/api/v0/models が読めるときは今までどおり（meta と /props を見ない）", async () => {
    stubContextWindowSetting(4096);
    const urls = stubServer({
      native: [
        {
          id: "google/gemma-4-e4b",
          type: "vlm",
          state: "loaded",
          max_context_length: 131072,
          loaded_context_length: 32768,
        },
      ],
      models: [{ ...llamaModel, id: "google/gemma-4-e4b" }],
      props: { default_generation_settings: { n_ctx: 2048 } },
    });

    const models = await new LmStudioProvider().listModels();

    expect(models[0].contextWindow).toBe(32768);
    // 名前から読む（meta の n_params の 25.2B にはならない）
    expect(models[0].parameterSize).toBe("4B");
    expect(urls.some((url) => url.endsWith("/props"))).toBe(false);
  });

  test("meta も /props も無いときは今までどおり（設定値・名前）", async () => {
    stubContextWindowSetting(16384);
    stubServer({ models: [{ id: "some-model-7b", object: "model" }] });

    const provider = new LmStudioProvider();
    const models = await provider.listModels();

    expect(models[0].contextWindow).toBe(16384);
    expect(models[0].parameterSize).toBe("7B");
    expect(models[0].loaded).toBeUndefined();
    expect(await provider.readModelLoadState("some-model-7b")).toBeUndefined();
    expect(await provider.readLoadedContextWindow()).toBeUndefined();
  });

  test("n_params だけ分かって長さが分からないときは、読み込み状況を返さない", async () => {
    // 分からないまま「未読込」と断じると、LM Studio の口で読み込ませに行く
    stubContextWindowSetting(16384);
    stubServer({
      models: [{ id: "gemma4:26b", meta: { n_params: 25233142046 } }],
    });

    const provider = new LmStudioProvider();
    const models = await provider.listModels();

    expect(models[0].parameterSize).toBe("25.2B");
    expect(models[0].contextWindow).toBe(16384);
    expect(await provider.readModelLoadState("gemma4:26b")).toBeUndefined();
  });

  test("複数のモデルが並ぶとき、/props の長さは別名の合うモデルにだけ当てる", async () => {
    stubContextWindowSetting(4096);
    stubServer({
      models: [
        llamaModel,
        { id: "other", meta: { n_ctx: 16384, n_params: 7_000_000_000 } },
      ],
      props: {
        default_generation_settings: { n_ctx: 6144 },
        model_alias: "gemma4:26b",
      },
    });

    const models = await new LmStudioProvider().listModels();
    const byId = new Map(models.map((m) => [m.id, m]));

    expect(byId.get("gemma4:26b")?.contextWindow).toBe(6144);
    expect(byId.get("other")?.contextWindow).toBe(16384);
    expect(byId.get("other")?.parameterSize).toBe("7.0B");
  });
});
