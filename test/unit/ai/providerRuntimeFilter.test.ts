import { describe, expect, test } from "vitest";
import { filterProvidersForRuntime } from "../../src/ai/registry";
import type { AIProvider } from "../../src/ai/types";

/**
 * ブラウザ版では、**手元のPCで動くものを選択肢に出さない**
 * （作者の指示、2026-08-21。LM Studio を足したのは2026-08-23）。
 *
 * **`canRunProcesses()` は実行環境そのものを見るので、単体テストからは
 * 片側（常にNode）しか確かめられない。** フィルタの中身だけを純粋な
 * 関数として切り出し、`canRun` を直接渡してテストする
 * （`src/ai/registry.ts` の `filterProvidersForRuntime`）。
 */

function provider(id: AIProvider["id"]): AIProvider {
  return {
    id,
    displayName: id,
    isPaid: id !== "ollama" && id !== "lmstudio",
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async () => {
      throw new Error("使わない");
    },
  };
}

describe("実行環境で選べないプロバイダを外す", () => {
  const all = [
    provider("ollama"),
    provider("lmstudio"),
    provider("gemini"),
    provider("openai"),
    provider("sakura"),
    provider("claude"),
  ];

  test("外部プロセスを起動できる（手元）なら、全部出す", () => {
    expect(filterProvidersForRuntime(all, true)).toEqual(all);
  });

  test("外部プロセスを起動できない（ブラウザ）なら、手元のものを外す", () => {
    // localhost はブラウザからは作者のPCではないので、選んでも必ず失敗する
    const result = filterProvidersForRuntime(all, false);
    expect(result.map((p) => p.id)).toEqual([
      "gemini",
      "openai",
      "sakura",
      "claude",
    ]);
  });

  /** **LM Studioも localhost である。** Ollamaだけ外しても足りない */
  test("LM Studioも外す", () => {
    const result = filterProvidersForRuntime(all, false);
    expect(result.map((p) => p.id)).not.toContain("lmstudio");
  });

  test("クラウドのものは減らさない", () => {
    const result = filterProvidersForRuntime(all, false);
    expect(result).toHaveLength(all.length - 2);
  });

  test("手元のものが無くても壊れない", () => {
    const cloudOnly = all.filter(
      (p) => p.id !== "ollama" && p.id !== "lmstudio"
    );
    expect(filterProvidersForRuntime(cloudOnly, false)).toEqual(cloudOnly);
  });
});
