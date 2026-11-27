import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 埋め込み（検索索引・意味検索・伏線の照合・コンテストの似かた）も、手元のAIの宛先が
 * PC の外なら送る前に確かめる（設計書6.78の17）。
 *
 * 生成の道は `confirmLocalAiDestination` を通るのに、埋め込みは `novelai.ollama.endpoint` へ
 * そのまま送っていた。宛先が別の機械を指していると、本文のチャンクが確認なしに出ていった
 * （2026-11-27 のレビューで見つけた）。入口が多いので、送り口の1か所で止める。
 */

const confirmLocalAiHost = vi.fn<(target: { endpoint: string; settingKey: string }) => Promise<boolean>>();
vi.mock("../../../src/features/localAiHostApproval", () => ({
  confirmLocalAiHost: (target: { endpoint: string; settingKey: string }) => confirmLocalAiHost(target),
}));

const localFetch = vi.fn<(...args: unknown[]) => Promise<Response>>();
vi.mock("../../../src/ai/fetchTimeouts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ai/fetchTimeouts")>()),
  localFetch: (...args: unknown[]) => localFetch(...args),
}));

const { OllamaEmbeddingProvider } = await import("../../../src/ai/ollamaEmbedding");
const { EmbeddingError } = await import("../../../src/ai/embeddingProvider");

beforeEach(() => {
  confirmLocalAiHost.mockReset();
  localFetch.mockReset();
  localFetch.mockResolvedValue(
    new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })
  );
});

describe("埋め込みも宛先を確かめてから送る", () => {
  test("［送る］と答えなければ送らず、断ったと分かる失敗で止める", async () => {
    confirmLocalAiHost.mockResolvedValue(false);
    const error = await new OllamaEmbeddingProvider("bge-m3").embed(["本文"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as InstanceType<typeof EmbeddingError>).kind).toBe("declined");
    expect(localFetch).not.toHaveBeenCalled();
  });

  test("送ってよければ、確かめた宛先へ送る", async () => {
    confirmLocalAiHost.mockResolvedValue(true);
    const vectors = await new OllamaEmbeddingProvider("bge-m3").embed(["本文"]);
    expect(vectors).toHaveLength(1);
    expect(confirmLocalAiHost).toHaveBeenCalledTimes(1);
    const target = confirmLocalAiHost.mock.calls[0][0];
    expect(target.settingKey).toBe("novelai.ollama.endpoint");
    expect(String(localFetch.mock.calls[0][0]).startsWith(target.endpoint)).toBe(true);
  });

  test("空の頼みは確かめもしない（送るものが無い）", async () => {
    expect(await new OllamaEmbeddingProvider("bge-m3").embed([])).toEqual([]);
    expect(confirmLocalAiHost).not.toHaveBeenCalled();
  });
});
