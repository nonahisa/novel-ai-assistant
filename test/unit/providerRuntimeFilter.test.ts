import { describe, expect, test } from "vitest";
import { filterProvidersForRuntime } from "../../src/ai/registry";
import type { AIProvider } from "../../src/ai/types";

/**
 * ブラウザ版では、Ollamaを選択肢に出さない（作者の指示、2026-08-21）。
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
    isPaid: id !== "ollama",
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
    provider("gemini"),
    provider("openai"),
    provider("sakura"),
    provider("claude"),
  ];

  test("外部プロセスを起動できる（手元）なら、全部出す", () => {
    expect(filterProvidersForRuntime(all, true)).toEqual(all);
  });

  test("外部プロセスを起動できない（ブラウザ）なら、Ollamaだけ外す", () => {
    // localhost はブラウザからは作者のPCではないので、選んでも必ず失敗する
    const result = filterProvidersForRuntime(all, false);
    expect(result.map((p) => p.id)).toEqual([
      "gemini",
      "openai",
      "sakura",
      "claude",
    ]);
  });

  test("Ollama以外は減らさない", () => {
    const result = filterProvidersForRuntime(all, false);
    expect(result).toHaveLength(all.length - 1);
  });

  test("Ollamaが無くても壊れない", () => {
    const withoutOllama = all.filter((p) => p.id !== "ollama");
    expect(filterProvidersForRuntime(withoutOllama, false)).toEqual(
      withoutOllama
    );
  });
});
