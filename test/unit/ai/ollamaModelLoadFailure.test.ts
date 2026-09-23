import { describe, expect, test } from "vitest";
import { isModelLoadFailure } from "../../src/ai/ollamaProvider";
import { AIError, recoveryForAIError } from "../../src/ai/types";

/**
 * Ollamaが「モデルを載せられなかった」ときを、応答の形の問題と分けて扱う
 * （設計書6.28.11）。
 */
describe("Ollamaのモデル読み込み失敗の判別", () => {
  test("作者が実際に受け取った本文を、読み込み失敗と判る", () => {
    // 実データ（2026-08-30、gemma4:26b で「読める長さの測定」を実行）
    const detail = JSON.stringify({
      error:
        "llama-server process has terminated: exit status 1: " +
        "llama_init_from_model: failed to initialize the context: " +
        "Gemma4Assistant requires ctx_other to be set " +
        "(this warning is normal during memory fitting)\n" +
        "error loading model: vector",
    });
    expect(isModelLoadFailure(detail)).toBe(true);
  });

  test("メモリ不足の言い回しも拾う", () => {
    expect(
      isModelLoadFailure('{"error":"model requires more system memory (19.0 GiB)"}')
    ).toBe(true);
    expect(isModelLoadFailure('{"error":"unable to load model /path/to.gguf"}')).toBe(
      true
    );
  });

  test("読み込みと関係のない失敗は、これまでどおり扱う", () => {
    // **原因を当てにいかない。** 名指ししていないものは丸めない
    expect(isModelLoadFailure('{"error":"invalid options: num_predict"}')).toBe(false);
    expect(isModelLoadFailure('{"error":"context canceled"}')).toBe(false);
    expect(isModelLoadFailure("")).toBe(false);
  });
});

describe("読み込み失敗の案内", () => {
  test("特定のサービス名を書かない", () => {
    // 以前はLM Studio決め打ちで、Ollamaで出ると押しても意味のない
    // 設定名を案内していた（CLAUDE.md 規則5）
    const recovery = recoveryForAIError(
      new AIError("Ollamaがモデルを読み込めませんでした。", "model_load_failed")
    );
    expect(recovery).not.toMatch(/LM Studio|Ollama|Gemini|Claude|ChatGPT/);
    // 作者が取れる手を示している
    expect(recovery).toMatch(/小さいモデル/);
    expect(recovery).toMatch(/文脈|メモリ/);
  });
});
