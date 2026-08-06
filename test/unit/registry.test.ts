import { beforeEach, describe, expect, test, vi } from "vitest";
import { runSetupWizard } from "../../src/ai/registry";
import type { AIProvider, ModelInfo } from "../../src/ai/types";
import type { AIRegistry } from "../../src/ai/registry";
import { window } from "./support/vscodeStub";

const model: ModelInfo = {
  id: "model-1",
  displayName: "Model 1",
  contextWindow: 8192,
  parameterSize: "8B",
  capabilities: ["JSON"],
  tier: "standard",
};

describe("AI設定ウィザード", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("接続成功後に選択したプロバイダとモデルを保存する", async () => {
    const provider: AIProvider = {
      id: "ollama",
      displayName: "Ollama",
      isConfigured: vi.fn(async () => true),
      testConnection: vi.fn(async () => ({
        ok: true,
        message: "connected",
        modelCount: 1,
      })),
      listModels: vi.fn(async () => [model]),
      generate: vi.fn(),
    };
    const select = vi.fn(async () => undefined);
    const registry = {
      listProviders: () => [provider],
      getProvider: () => provider,
      select,
    } as unknown as AIRegistry;
    const quickPick = vi
      .fn()
      .mockResolvedValueOnce({ providerId: "ollama" })
      .mockResolvedValueOnce({ model });
    Object.assign(window, {
      showQuickPick: quickPick,
      withProgress: vi.fn(async (_options, task) => task()),
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
    });

    await expect(runSetupWizard(registry)).resolves.toBe(true);
    expect(provider.testConnection).toHaveBeenCalledOnce();
    expect(provider.listModels).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith("ollama", "model-1");
  });
});
