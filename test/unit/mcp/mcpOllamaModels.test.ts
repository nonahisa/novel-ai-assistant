import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledTuningKeys } from "../../../src/core/bundledTuning";
import { ollamaModels } from "../../../src/mcp/tools/ollama";

/**
 * 手元の Ollama に何が入っているか（設計書6.87.15 の柱2の2）。
 *
 * **なぜ要るか。** `runner: "ollama"` には `model` が要るのに、**手元に何が
 * あるかを外部AIが知る道具が無かった。** 名前を当てずっぽうで書けば、
 * 失敗してから気づくことになる。
 *
 * **見張りたいのは3つ。**
 *
 * 1. `/api/show` の言うこと（読める長さ・対応機能）をそのまま返すこと
 *    ——モデル名から当てにいかない（CLAUDE.md 規則6）
 * 2. **1つのモデルの失敗で全体を止めないこと**（チャンク単位の失敗と同じ作法）
 * 3. 繋がらないときは**本文を捨てずに**断ること（規則5）
 */

/** 同梱の実測を持っているモデル名（`ollama/` の1件を借りる） */
const BUNDLED_MODEL = bundledTuningKeys()
  .filter((key) => key.startsWith("ollama/"))
  .map((key) => key.slice("ollama/".length))[0];

interface ShowBody {
  model?: string;
}

/**
 * 偽の Ollama。`/api/tags` と `/api/show` に答える。
 *
 * `failFor` に挙げたモデルは `/api/show` が HTTP 500 を返す。
 */
function stubOllama(options: {
  models: Array<{ name: string; size?: number }>;
  failFor?: string[];
}): void {
  const failFor = new Set(options.failFor ?? []);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: options.models.map((model) => ({
              name: model.name,
              size: model.size ?? 1_234_567,
              modified_at: "2026-09-01T00:00:00Z",
              details: {
                family: "gemma4",
                parameter_size: "12B",
                quantization_level: "Q4_K_M",
              },
            })),
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/api/show")) {
        const body = JSON.parse(init?.body ?? "{}") as ShowBody;
        const name = body.model ?? "";
        if (failFor.has(name)) {
          return new Response("model not found", { status: 500 });
        }
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            model_info: {
              "general.architecture": "gemma4",
              "gemma4.context_length": 131_072,
              // **アーキ違いの鍵も混ぜる。** 先頭から拾うだけの読み方だと、
              // ここで別のモデルの長さを掴む
              "clip.context_length": 512,
            },
          }),
          { status: 200 }
        );
      }
      throw new Error(`思っていない宛先: ${url}`);
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ollama.models", () => {
  it("名前・読める長さ・対応機能・同梱の実測を返す", async () => {
    stubOllama({ models: [{ name: BUNDLED_MODEL }, { name: "他:8b" }] });

    const result = await ollamaModels({});

    expect(result.endpoint).toBe("http://localhost:11434");
    expect(result.models.map((model) => model.name)).toEqual([
      BUNDLED_MODEL,
      "他:8b",
    ]);

    const first = result.models[0];
    // **アーキ名から組み立てた鍵で拾う**（`clip.context_length` ではない）
    expect(first.contextLength).toBe(131_072);
    expect(first.capabilities).toContain("completion");
    expect(first.parameterSize).toBe("12B");
    expect(first.quantization).toBe("Q4_K_M");
    expect(first.sizeBytes).toBe(1_234_567);
    // 同梱の実測は**出どころが分かる形**で添える（測った日が入っている）
    expect(first.bundled?.measuredAt).toBeTruthy();
    // 同梱に無いモデルは null（黙って埋めない）
    expect(result.models[1].bundled).toBeNull();

    expect(result.failures).toEqual([]);
    // 台帳が読めないことは、返事で断る
    expect(result.note).toContain("novelai.modelTuning");
    expect(result.note).toContain("completion");
    expect(result.note).toContain("numCtx");
  });

  it("末尾を切っていない endpoint を渡しても、同じ宛先を見る", async () => {
    stubOllama({ models: [{ name: "x:1b" }] });
    const result = await ollamaModels({ endpoint: "http://localhost:11434/" });
    expect(result.endpoint).toBe("http://localhost:11434");
  });

  it("1つのモデルの詳細が取れなくても、ほかは返る（failures に残す）", async () => {
    stubOllama({
      models: [{ name: "壊れた:1b" }, { name: "無事:8b" }],
      failFor: ["壊れた:1b"],
    });

    const result = await ollamaModels({});

    // **名前は返す。** 詳細が取れないだけで `run` には使える
    expect(result.models.map((model) => model.name)).toEqual([
      "壊れた:1b",
      "無事:8b",
    ]);
    expect(result.models[0].contextLength).toBeNull();
    expect(result.models[0].capabilities).toEqual([]);
    expect(result.models[1].contextLength).toBe(131_072);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].model).toBe("壊れた:1b");
    // **本文を捨てない**（規則5）
    expect(result.failures[0].reason).toContain("500");
    expect(result.failures[0].reason).toContain("model not found");
  });

  it("繋がらなければ、宛先と理由を付けて断る", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    await expect(ollamaModels({})).rejects.toThrow(/繋がりませんでした/);
    await expect(ollamaModels({})).rejects.toThrow(/ECONNREFUSED/);
  });

  it("Ollama がエラーを返したら、本文ごと知らせる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("そんな口はありません", { status: 404 }))
    );
    await expect(ollamaModels({})).rejects.toThrow(/404/);
    await expect(ollamaModels({})).rejects.toThrow(/そんな口はありません/);
  });

  it("models が無い応答でも落ちない（0件として返す）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    );
    const result = await ollamaModels({});
    expect(result.models).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});
