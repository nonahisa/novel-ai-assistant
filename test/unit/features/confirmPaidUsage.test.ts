import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { confirmPaidUsage } from "../../../src/features/aiConnectivity";
import type { AIProvider } from "../../../src/ai/types";
import { answerConfirms, type ConfirmPicker } from "../support/confirmPicker";

function provider(isPaid: boolean, displayName = "Claude API"): AIProvider {
  return { isPaid, displayName } as unknown as AIProvider;
}

describe("有料AIを使う前の確認", () => {
  let shown: Array<{ message: string; detail?: string }>;
  let picker: ConfirmPicker | undefined;

  /**
   * 確認は画面上部の選択窓で出る（A4、2026-09-23）。文は窓の題、
   * 説明は「内容」の下の行（長い行は折り返されるので、改行を除いてつなぐ）
   */
  function answering(answer: string | undefined): void {
    picker?.restore();
    picker = answerConfirms((confirm) => {
      shown.push({ message: confirm.title, detail: confirm.rows.join("") });
      return answer;
    });
  }

  beforeEach(() => {
    shown = [];
    answering("実行");
  });

  afterEach(() => {
    picker?.restore();
    picker = undefined;
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
    answering(undefined);

    const ok = await confirmPaidUsage(provider(true), {
      actionLabel: "AIへの相談",
      model: "claude-sonnet-5",
    });

    expect(ok).toBe(false);
  });
});
