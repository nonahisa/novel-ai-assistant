import { beforeEach, describe, expect, test, vi } from "vitest";
import { commands, window } from "./support/vscodeStub";
import { resolveModelInfoOrWarn } from "../../src/features/chunkSettings";
import type { AIProvider, ModelInfo } from "../../src/ai/types";

/**
 * モデル情報が取れないときに、黙って既定値へ落ちない（設計書6.23・6.27.10）。
 *
 * チャンクの字数はモデルのコンテキスト長から決まる。取れないまま
 * `?? 8192` へ落ちると、131,072のモデルで20,000字だったチャンクが
 * **1,500字**になり、ハッシュが総入れ替えになってキャッシュが全滅し、
 * 呼び出し回数が十数倍になる。しかも作者には何も見えない。
 *
 * 誤字脱字検知と設定資料の抽出だけが「疎通を回復させて取り直し、
 * それでも駄目なら理由を出して中止する」手順を持っていた。推敲・矛盾検知・
 * 伏線（検知と回収）にはその手順が無く、写しを作らずに1つへ寄せる。
 */

function modelInfo(contextWindow: number): ModelInfo {
  return {
    id: "test-model",
    displayName: "test-model",
    contextWindow,
    parameterSize: null,
    capabilities: [],
    tier: "standard",
  };
}

/** `testConnection` を持たないプロバイダは、疎通確認を素通りする */
const provider = { id: "ollama" } as unknown as AIProvider;

describe("モデル情報が取れないときの関所", () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    window.showWarningMessage = vi.fn(async (message: string) => {
      warnings.push(message);
      return "中止";
    });
    (commands as { executeCommand?: unknown }).executeCommand = vi.fn(
      async () => undefined
    );
  });

  test("取れたら、そのまま返す", async () => {
    const info = await resolveModelInfoOrWarn({
      registry: { resolveModelInfo: async () => modelInfo(131072) },
      feature: "proofread",
      provider,
      model: "test-model",
      actionLabel: "推敲",
    });

    expect(info?.contextWindow).toBe(131072);
    expect(warnings).toEqual([]);
  });

  test("1回目で取れなくても、疎通を確かめてから取り直す", async () => {
    // モデル情報が取れない＝サーバーが止まっている経路そのものなので、
    // 起こしてもらってから取り直す。取れれば作者の手は止まらない
    let calls = 0;
    const info = await resolveModelInfoOrWarn({
      registry: {
        resolveModelInfo: async () =>
          ++calls === 1 ? undefined : modelInfo(32768),
      },
      feature: "proofread",
      provider,
      model: "test-model",
      actionLabel: "推敲",
    });

    expect(calls).toBe(2);
    expect(info?.contextWindow).toBe(32768);
    expect(warnings).toEqual([]);
  });

  test("最後まで取れなければ、理由を出して undefined を返す", async () => {
    // **既定値へ黙って落ちない。** 落ちると分割単位が変わり、
    // 作者からは「急に遅くなった」としか見えない
    const info = await resolveModelInfoOrWarn({
      registry: { resolveModelInfo: async () => undefined },
      feature: "contradiction",
      provider,
      model: "gemma4:e4b",
      actionLabel: "矛盾検知",
    });

    expect(info).toBeUndefined();
    expect(warnings).toHaveLength(1);
    // どのモデルの話か・何が起きるかが分からないと、作者は次の手を選べない
    expect(warnings[0]).toContain("gemma4:e4b");
    expect(warnings[0]).toContain("キャッシュ");
    // **サービス名も機能名も決め打ちしない**（「Claudeの…」と出た不具合と同じ形）
    expect(warnings[0]).toContain("矛盾検知");
  });

  test("「AIの設定を開く」を選んだら、そこへ連れて行く", async () => {
    window.showWarningMessage = vi.fn(async () => "AIの設定を開く");

    const info = await resolveModelInfoOrWarn({
      registry: { resolveModelInfo: async () => undefined },
      feature: "foreshadow",
      provider,
      model: "test-model",
      actionLabel: "伏線の検知",
    });

    expect(info).toBeUndefined();
    expect(
      (commands as { executeCommand: ReturnType<typeof vi.fn> }).executeCommand
    ).toHaveBeenCalledWith("novelai.setupAI");
  });

  test("疎通を回復できなければ、警告を出さずに中止する", async () => {
    // 疎通確認の側が既に理由を出している。二重に出さない
    const info = await resolveModelInfoOrWarn({
      registry: { resolveModelInfo: async () => undefined },
      feature: "typo",
      provider: {
        id: "ollama",
        testConnection: async () => ({ ok: false, message: "繋がりません" }),
      } as unknown as AIProvider,
      model: "test-model",
      actionLabel: "誤字脱字の検知",
    });

    expect(info).toBeUndefined();
    // 出したのは疎通確認の警告だけ（「中止」を返すので1回で終わる）
    expect(warnings.some((text) => text.includes("キャッシュ"))).toBe(false);
  });
});
