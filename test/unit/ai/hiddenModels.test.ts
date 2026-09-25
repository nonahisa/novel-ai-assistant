import { describe, expect, test } from "vitest";
import {
  hiddenModel,
  hiddenModelKeys,
  hiddenModelsOf,
  manualModelEntryPrompt,
} from "../../../src/ai/hiddenModels";

/**
 * 選ぶ画面の候補に出さないモデル（作者の裁定、2026-09-26 深夜）。
 *
 * 表は同梱の初期値（`core/bundledTuning.ts`）と同じ約束で持つ——実際に
 * 測ったものだけ、測った日と何で測ったかを添えて。
 */
describe("候補から外すモデルの表", () => {
  test("作者が外すと決めた2つが入っている", () => {
    expect(hiddenModel("sakura", "llm-jp-3.1-8x13b-instruct4")).toBeDefined();
    expect(hiddenModel("sakura", "preview/Qwen3-0.6B-cpu")).toBeDefined();
    expect(hiddenModelsOf("sakura").sort()).toEqual(
      ["llm-jp-3.1-8x13b-instruct4", "preview/Qwen3-0.6B-cpu"].sort()
    );
  });

  test("ほかのモデル・ほかのプロバイダは外さない（名前が同じでも鍵はプロバイダごと）", () => {
    expect(hiddenModel("sakura", "preview/gemma-4-31B-it")).toBeUndefined();
    expect(hiddenModel("sakura", "preview/Phi-4-mini-instruct-cpu")).toBeUndefined();
    expect(hiddenModel("ollama", "llm-jp-3.1-8x13b-instruct4")).toBeUndefined();
    expect(hiddenModelsOf("ollama")).toEqual([]);
  });

  test("どの行も、理由・何で測ったか・測った日を持つ（同梱の表と同じ約束）", () => {
    for (const key of hiddenModelKeys()) {
      const [providerId, ...rest] = key.split("/");
      const entry = hiddenModel(providerId, rest.join("/"));
      expect(entry, key).toBeDefined();
      expect(entry?.reason.trim().length, key).toBeGreaterThan(0);
      expect(entry?.bench.trim().length, key).toBeGreaterThan(0);
      expect(entry?.measuredAt, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("名前を入れる案内は、外したモデルの名前と理由を並べる。外していなければ出さない", () => {
    const prompt = manualModelEntryPrompt("sakura");
    expect(prompt).toContain("llm-jp-3.1-8x13b-instruct4");
    expect(prompt).toContain("preview/Qwen3-0.6B-cpu");
    expect(prompt).toContain("指示の言葉をそのまま返しました");
    expect(prompt).toContain("2026-09-26");
    expect(manualModelEntryPrompt("ollama")).toBeUndefined();
    expect(manualModelEntryPrompt("openai")).toBeUndefined();
  });

  test("画面に出す理由に、開発中の内輪の呼び名を書かない", () => {
    for (const key of hiddenModelKeys()) {
      const [providerId, ...rest] = key.split("/");
      expect(hiddenModel(providerId, rest.join("/"))?.reason).not.toMatch(/母艦/);
    }
  });
});
