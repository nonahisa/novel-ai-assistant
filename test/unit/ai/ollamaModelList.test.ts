import { describe, expect, test } from "vitest";
import { isGenerationModel } from "../../src/ai/ollamaProvider";

/**
 * 埋め込み用のモデルを一覧に出さない（設計書6.28.10）。
 *
 * 作者の報告「bge-m3 が出るが選んでも使えない」（2026-08-30）。
 * 期待値は実機の Ollama から取った実データに合わせてある。
 */
describe("Ollamaの一覧に出すモデルの選別", () => {
  describe("capabilities が取れるとき", () => {
    test("completion があれば生成に使える", () => {
      // 実測（2026-08-30）
      expect(isGenerationModel("qwen3:8b", ["completion", "tools", "thinking"])).toBe(
        true
      );
      expect(
        isGenerationModel("qwen3.8:latest", [
          "completion",
          "tools",
          "thinking",
          "vision",
        ])
      ).toBe(true);
      expect(isGenerationModel("gemma3:12b", ["completion"])).toBe(true);
    });

    test("embedding だけのモデルは落とす", () => {
      // 実測（2026-08-30）。**名前に embed が入らない埋め込みモデル**なので、
      // 名前だけの判定では拾えない
      expect(isGenerationModel("bge-m3:latest", ["embedding"])).toBe(false);
    });

    test("名前が紛らわしくても capabilities を優先する", () => {
      // 名前に embed が入っていても、生成できるなら残す
      expect(isGenerationModel("embedgemma-chat:latest", ["completion"])).toBe(true);
      // 逆に、生成できそうな名前でも capabilities が embedding なら落とす
      expect(isGenerationModel("gemma-friendly:latest", ["embedding"])).toBe(false);
    });
  });

  describe("capabilities が取れないとき（古い版・/api/show の失敗）", () => {
    test("用途を表す語が名前に入っていれば落とす", () => {
      expect(isGenerationModel("nomic-embed-text:latest", undefined)).toBe(false);
      expect(isGenerationModel("mxbai-embed-large", [])).toBe(false);
      expect(isGenerationModel("bge-reranker-v2", undefined)).toBe(false);
      // 大文字小文字を問わない
      expect(isGenerationModel("Some-EMBED-Model", undefined)).toBe(false);
    });

    test("判断が付かないものは残す", () => {
      // **取りこぼしのほうが害が大きい。** 使えるモデルが一覧から消えると、
      // 作者には理由が分からない
      expect(isGenerationModel("bge-m3:latest", undefined)).toBe(true);
      expect(isGenerationModel("qwen3:8b", undefined)).toBe(true);
      expect(isGenerationModel("知らないモデル:latest", [])).toBe(true);
    });
  });
});
