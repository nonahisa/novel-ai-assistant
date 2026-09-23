import { describe, expect, test } from "vitest";
import { probeGeneration } from "../../src/ai/generationProbe";
import { AIError, type AIProvider, type GenerateParams } from "../../src/ai/types";

/**
 * モデル一覧が引けても生成できるとは限らない。
 * Anthropicは残高ゼロでもモデル一覧を返すため、一覧だけを見た接続テストは
 * 「接続しました（モデル10件）」と成功を報告してしまい、
 * 作者は抽出を走らせたあとで残高不足を知ることになった。
 */

function provider(
  generate: (params: GenerateParams) => Promise<never> | Promise<unknown>
): AIProvider {
  return {
    id: "claude",
    displayName: "Claude",
    isPaid: true,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "", modelCount: 10 }),
    listModels: async () => [],
    generate: generate as AIProvider["generate"],
  };
}

describe("生成できるかの確認", () => {
  test("生成できれば成功にする", async () => {
    const result = await probeGeneration(
      provider(async () => ({
        text: "はい",
        truncated: false,
        elapsedMs: 1,
      })),
      "claude-opus-5"
    );

    expect(result.ok).toBe(true);
  });

  test("本文は渡さない。確認のために課金を膨らませない", async () => {
    let seen: GenerateParams | undefined;
    await probeGeneration(
      provider(async (params) => {
        seen = params;
        return { text: "はい", truncated: false, elapsedMs: 1 };
      }),
      "claude-opus-5"
    );

    expect(seen?.userPrompt.length).toBeLessThan(40);
    expect(seen?.model).toBe("claude-opus-5");
    // 抽出と違って形式を強制する必要はない。
    // スキーマ未対応のモデルを、無関係な理由で失敗させないため
    expect(seen?.jsonSchema).toBeUndefined();
  });

  test("流し受信は使わない。確かめるのは配布と同じ道である", async () => {
    // 開発ビルド限定の流し受信（設計書6.63.1）で確認を通すと、
    // **作者が実際に使う道とは別の道**が生きていることを確かめてしまう。
    // 「生成できるか」の答えとして、それでは意味がない
    let seen: GenerateParams | undefined;
    await probeGeneration(
      provider(async (params) => {
        seen = params;
        return { text: "はい", truncated: false, elapsedMs: 1 };
      }),
      "claude-opus-5"
    );

    expect(seen?.disableStreaming).toBe(true);
  });

  test("残高不足はそのまま伝える", async () => {
    // 待っても回復しないので、再試行を促してはいけない
    const result = await probeGeneration(
      provider(async () => {
        throw new AIError(
          "残高が不足しています。console.anthropic.com で追加してください。",
          "insufficient_credit"
        );
      }),
      "claude-opus-5"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "残高が不足しています。console.anthropic.com で追加してください。"
    );
    expect(result.error?.kind).toBe("insufficient_credit");
  });

  test("モデルを読み込めなかった理由は、定型文で覆わない", async () => {
    // 「一覧は取得できましたが、実際の生成に失敗しました」で始めると、
    // AI側が言っている具体的な理由（メモリがいくら足りないか）が
    // 後ろへ押しやられる。原因が分かっているものに定型文は要らない
    const result = await probeGeneration(
      provider(async () => {
        throw new AIError(
          "LM Studio がモデル「google/gemma-4-12b-qat」を読み込めませんでした。" +
            "メモリ不足の見込みで読み込みを止めました（LM Studio の安全装置）。",
          "model_load_failed"
        );
      }),
      "google/gemma-4-12b-qat"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("google/gemma-4-12b-qat");
    expect(result.message).toContain("メモリ不足");
    expect(result.message).not.toContain("モデルの一覧は取得できましたが");
    // 次に何をすればよいかは添える
    expect(result.message).toContain("より小さいモデル");
    expect(result.error?.kind).toBe("model_load_failed");
  });

  test("それ以外の失敗は、一覧は引けたことを添えて伝える", async () => {
    const result = await probeGeneration(
      provider(async () => {
        throw new AIError("権限がありません。", "permission_denied");
      }),
      "claude-opus-5"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("一覧は取得できました");
    expect(result.error?.kind).toBe("permission_denied");
  });

  test("AIError でない失敗も握りつぶさない", async () => {
    const result = await probeGeneration(
      provider(async () => {
        throw new Error("ネットワークに接続できません");
      }),
      "claude-opus-5"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ネットワークに接続できません");
  });
});
