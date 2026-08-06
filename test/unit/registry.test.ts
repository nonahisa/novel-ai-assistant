import { beforeEach, describe, expect, test, vi } from "vitest";
import { runSetupWizard } from "../../src/ai/registry";
import type { AIProvider, ModelInfo } from "../../src/ai/types";
import type { AIRegistry } from "../../src/ai/registry";
import { commands, window } from "./support/vscodeStub";

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

  test("接続失敗時に選択したプロバイダの設定を開ける", async () => {
    const provider: AIProvider = {
      id: "ollama",
      displayName: "Ollama",
      isConfigured: vi.fn(async () => true),
      testConnection: vi.fn(async () => ({
        ok: false,
        message: "Ollamaに接続できません。",
      })),
      listModels: vi.fn(async () => []),
      generate: vi.fn(),
    };
    const registry = {
      listProviders: () => [provider],
      getProvider: () => provider,
      select: vi.fn(async () => undefined),
    } as unknown as AIRegistry;
    const executeCommand = vi.fn(async () => undefined);
    Object.assign(commands, { executeCommand });
    Object.assign(window, {
      showQuickPick: vi.fn(async () => ({ providerId: "ollama" })),
      withProgress: vi.fn(async (_options, task) => task()),
      showErrorMessage: vi.fn(async () => "設定を開く"),
      showWarningMessage: vi.fn(async () => undefined),
      showInformationMessage: vi.fn(async () => undefined),
    });

    await expect(runSetupWizard(registry)).resolves.toBe(false);
    expect(executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "novelai.ollama"
    );
    expect(provider.listModels).not.toHaveBeenCalled();
  });

  test("利用可能なモデルが0件なら保存せず明確に通知する", async () => {
    const provider: AIProvider = {
      id: "ollama",
      displayName: "Ollama",
      isConfigured: vi.fn(async () => true),
      testConnection: vi.fn(async () => ({
        ok: true,
        message: "接続しました。",
        modelCount: 1,
      })),
      listModels: vi.fn(async () => []),
      generate: vi.fn(),
    };
    const select = vi.fn(async () => undefined);
    const registry = {
      listProviders: () => [provider],
      getProvider: () => provider,
      select,
    } as unknown as AIRegistry;
    const showWarningMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showQuickPick: vi.fn(async () => ({ providerId: "ollama" })),
      withProgress: vi.fn(async (_options, task) => task()),
      showErrorMessage: vi.fn(async () => undefined),
      showWarningMessage,
      showInformationMessage: vi.fn(async () => undefined),
    });

    await expect(runSetupWizard(registry)).resolves.toBe(false);
    expect(showWarningMessage).toHaveBeenCalledWith(
      "利用可能なモデルが見つかりませんでした。"
    );
    expect(select).not.toHaveBeenCalled();
  });
});
