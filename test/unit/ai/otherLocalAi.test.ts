import { describe, expect, it, vi } from "vitest";
import "./support/vscodeStub";
import {
  isLocalProvider,
  noteOtherLocalAiRunning,
  otherLocalAi,
} from "../../src/ai/otherLocalAi";

/**
 * **2つの推論エンジンが同じメモリを取り合う状況は、こちらが作っている**
 * （設計書6.62.2）。機能別割当で「誤字脱字はLM Studio、抽出はOllama」と
 * 分けられる作りなので、両方が同時に載ることがある。
 *
 * 作者のログ（2026-09-01）では、LM Studio が12Bを文脈131,072で保持している
 * 最中に Ollama が18GBのモデルを載せにいって落ちた。それなのに案内は
 * 「より小さいモデルを選ぶか、文脈を短く」だけで、**いちばん効く一手
 * （もう一方を終了する）を言っていなかった。**
 */
describe("もう一方の手元AI", () => {
  it("手元で動くのは Ollama と LM Studio", () => {
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("lmstudio")).toBe(true);
    expect(isLocalProvider("sakura")).toBe(false);
    expect(isLocalProvider("claude")).toBe(false);
  });

  it("失敗した側から見た相手を返す", () => {
    expect(otherLocalAi("ollama")?.name).toBe("LM Studio");
    expect(otherLocalAi("lmstudio")?.name).toBe("Ollama");
  });

  it("クラウドのAIには相手がいない（メモリを取り合わない）", () => {
    expect(otherLocalAi("sakura")).toBeUndefined();
    expect(otherLocalAi("gemini")).toBeUndefined();
  });

  it("相手が動いていれば、終了を勧める一文を返す", async () => {
    const note = await noteOtherLocalAiRunning("ollama", async () => true);
    expect(note).toContain("LM Studio");
    expect(note).toContain("取り合");
  });

  it("**動いていなければ何も言わない**", async () => {
    // 心当たりの無い助言を並べると、本当に効く助言まで読み飛ばされる
    expect(await noteOtherLocalAiRunning("ollama", async () => false)).toBe("");
  });

  it("クラウドのAIでは何も言わない", async () => {
    const probe = vi.fn(async () => true);
    expect(await noteOtherLocalAiRunning("claude", probe)).toBe("");
    // 相手がいないので、確かめにも行かない
    expect(probe).not.toHaveBeenCalled();
  });

  it("確かめられなくても、元の失敗の報告を妨げない", async () => {
    const note = await noteOtherLocalAiRunning("lmstudio", async () => {
      throw new Error("繋がらない");
    });
    expect(note).toBe("");
  });
});
