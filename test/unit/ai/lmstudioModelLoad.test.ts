import { afterEach, describe, expect, test, vi } from "vitest";
import { saveLoadedContextWindow } from "../../src/ai/lmstudioModelLoad";
import { workspace } from "./support/vscodeStub";

/**
 * `saveLoadedContextWindow`（実測の文脈長を設定へ書き戻す口）を呼ぶテストが
 * これまで0件だった（ノートPCの照合で判明、2026-09-22）。
 * `vscodeStub` の `getConfiguration` は既定では `update` を持たないので、
 * ここで読み書きの両方を差し替える。
 */

const LOADED_MODEL = {
  id: "google/gemma-4-e4b",
  object: "model",
  type: "vlm",
  state: "loaded",
  max_context_length: 131072,
  loaded_context_length: 131072,
};

/** 対応できる最大は分かるが、まだ読み込まれていないモデル */
const NOT_LOADED_MODEL = {
  id: "google/gemma-4-12b-qat",
  object: "model",
  type: "vlm",
  state: "not-loaded",
  max_context_length: 262144,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** LM Studioの `/api/v0/models` を立てる */
function stubLmStudio(native: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/v0/models")) {
        return jsonResponse({ data: native });
      }
      return jsonResponse({ data: [] });
    })
  );
}

/**
 * 設定の読み書きを差し替える。
 *
 * @param current いまの `lmstudio.contextWindow`
 * @returns 書き込まれた値を積む配列。呼ばれなければ空のまま
 */
function stubConfig(current: number): { updates: number[] } {
  const updates: number[] = [];
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, defaultValue: T): T =>
      key === "lmstudio.contextWindow" ? (current as unknown as T) : defaultValue,
    update: async (_key: string, value: number, _global?: boolean) => {
      updates.push(value);
    },
  })) as typeof workspace.getConfiguration;
  return { updates };
}

describe("saveLoadedContextWindow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("読み込み済みなら、実測値で設定を書き換える", async () => {
    stubLmStudio([LOADED_MODEL]);
    const { updates } = stubConfig(8192);

    const result = await saveLoadedContextWindow(LOADED_MODEL.id);

    expect(result).toBe(131072);
    expect(updates).toEqual([131072]);
  });

  test("未読込で実測が取れなければ、設定を書き換えない", async () => {
    // 対応できる最大（262144）は分かっても、それは実測ではない。
    // 実測より大きい値を当てずっぽうで書くと、入力が黙って切り捨てられる
    stubLmStudio([NOT_LOADED_MODEL]);
    const { updates } = stubConfig(8192);

    const result = await saveLoadedContextWindow(NOT_LOADED_MODEL.id);

    expect(result).toBeUndefined();
    expect(updates).toEqual([]);
  });
});
