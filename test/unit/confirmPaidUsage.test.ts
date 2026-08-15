import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "./support/vscodeStub";
import { confirmPaidUsage } from "../../src/features/aiConnectivity";
import type { AIProvider } from "../../src/ai/types";

function provider(isPaid: boolean, displayName = "Claude API"): AIProvider {
  return { isPaid, displayName } as unknown as AIProvider;
}

describe("有料AIを使う前の確認", () => {
  let shown: Array<{ message: string; detail?: string }>;

  beforeEach(() => {
    shown = [];
    window.showInformationMessage = vi.fn(
      async (message: string, options?: { detail?: string }) => {
        shown.push({ message, detail: options?.detail });
        return "実行";
      }
    );
  });

  test("無料のAIでは何も出さずに通す", async () => {
    // 毎回確認を挟むと、ローカルで気軽に試す使い方が成り立たない
    const ok = await confirmPaidUsage(provider(false, "Ollama"), {
      actionLabel: "AIへの相談",
      model: "gemma4:e4b",
    });

    expect(ok).toBe(true);
    expect(shown).toHaveLength(0);
  });

  test("有料のAIではトークンを消費すると伝える", async () => {
    const ok = await confirmPaidUsage(provider(true), {
      actionLabel: "作品紹介文の生成",
      model: "claude-sonnet-5",
    });

    expect(ok).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0].message).toContain("作品紹介文の生成");
    expect(shown[0].detail).toContain("トークンを消費");
    // どのサービスのどのモデルかが分からないと、料金の見当が付かない
    expect(shown[0].detail).toContain("Claude API");
    expect(shown[0].detail).toContain("claude-sonnet-5");
  });

  test("呼び出し回数が分かるときは添える", async () => {
    await confirmPaidUsage(provider(true), {
      actionLabel: "プロットの逆算",
      model: "claude-sonnet-5",
      calls: 1,
    });

    expect(shown[0].detail).toContain("1回");
  });

  test("追加の説明を添えられる", async () => {
    await confirmPaidUsage(provider(true), {
      actionLabel: "AIへの相談",
      model: "claude-sonnet-5",
      detail: "送信するたびに1回ずつ課金されます。",
    });

    expect(shown[0].detail).toContain("送信するたびに");
  });

  test("断られたら実行しない", async () => {
    window.showInformationMessage = vi.fn(async () => undefined);

    const ok = await confirmPaidUsage(provider(true), {
      actionLabel: "AIへの相談",
      model: "claude-sonnet-5",
    });

    expect(ok).toBe(false);
  });
});
