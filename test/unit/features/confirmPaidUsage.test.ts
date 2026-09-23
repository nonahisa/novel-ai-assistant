import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, type StubMessage } from "./support/vscodeStub";
import { confirmPaidUsage } from "../../src/features/aiConnectivity";
import type { AIProvider } from "../../src/ai/types";

function provider(isPaid: boolean, displayName = "Claude API"): AIProvider {
  return { isPaid, displayName } as unknown as AIProvider;
}

/**
 * モーダルの設定から説明文だけを取り出す。
 *
 * **形が違えば「無かった」と扱う。** ここで決めつけると、
 * 呼び出し側が引数の並びを変えたときに黙って通ってしまう
 */
function detailOf(option: unknown): string | undefined {
  if (typeof option !== "object" || option === null) return undefined;
  if (!("detail" in option)) return undefined;
  return typeof option.detail === "string" ? option.detail : undefined;
}

describe("有料AIを使う前の確認", () => {
  let shown: Array<{ message: string; detail?: string }>;

  beforeEach(() => {
    shown = [];
    // 画面の知らせは「文言＋何でも受ける残りの引数」という形（`StubMessage`）。
    // 2つ目がモーダルの設定（`{ modal, detail }`）、3つ目以降がボタンである
    window.showInformationMessage = vi.fn<StubMessage>(
      async (message, ...items) => {
        shown.push({ message, detail: detailOf(items[0]) });
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
