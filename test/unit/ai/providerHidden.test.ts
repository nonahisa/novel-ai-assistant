import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { AIRegistry } from "../../../src/ai/registry";
import { probeVsCodeLm } from "../../../src/ai/vscodeLmProvider";
import { lm } from "../support/vscodeStub";

/**
 * 口が働かないエディターでは、AIの選択肢から「VS Code に繋いであるAI」を
 * 外す（設計書5.9。作者の裁定 2026-10-31「Bにしましょう」）。
 */

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as vscode.ExtensionContext;
}

describe("AIの選択肢から外す", () => {
  test("隠すと一覧から消え、ほかの接続先は残る。選んであるものは切り替えない", async () => {
    const registry = new AIRegistry(fakeContext());
    await registry.select("vscode-lm", "copilot-x");
    expect(registry.listProviders().map((p) => p.id)).toContain("vscode-lm");

    registry.setProviderHidden("vscode-lm", true);
    const ids = registry.listProviders().map((p) => p.id);
    expect(ids).not.toContain("vscode-lm");
    expect(ids).toContain("gemini");
    expect(registry.selectedProviderId).toBe("vscode-lm");
    // 取り出す口は残す（キー割り当てや前の選択から呼ばれたときの受け皿）
    expect(registry.getProvider("vscode-lm")).toBeDefined();
  });
});

describe("口の確かめ（エディターの名前は見ない）", () => {
  test("口があれば、モデルが0件でも「使える」（Copilot 未サインインの VS Code を隠さない）", async () => {
    expect(await probeVsCodeLm()).toBe("available");
  });

  test("一覧を引くと投げるなら「使えない」", async () => {
    const original = lm.selectChatModels;
    lm.selectChatModels = async () => {
      throw new Error("not implemented");
    };
    try {
      expect(await probeVsCodeLm()).toBe("unavailable");
    } finally {
      lm.selectChatModels = original;
    }
  });

  test("口が無ければ「使えない」", async () => {
    const original = lm.selectChatModels;
    (lm as { selectChatModels?: unknown }).selectChatModels = undefined;
    try {
      expect(await probeVsCodeLm()).toBe("unavailable");
    } finally {
      lm.selectChatModels = original;
    }
  });
});
