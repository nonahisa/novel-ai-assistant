import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { confirmPaidUsage } from "../../../src/features/aiConnectivity";
import type { AIProvider } from "../../../src/ai/types";
import { answerConfirms, type ConfirmPicker } from "../support/confirmPicker";

function provider(isPaid: boolean, displayName = "Claude API"): AIProvider {
  return { isPaid, displayName } as unknown as AIProvider;
}

describe("有料AIを使う前の確認", () => {
  let shown: Array<{ message: string; rows: readonly string[]; more: readonly string[] }>;
  let picker: ConfirmPicker | undefined;

  /**
   * 確認は画面上部の選択窓で出る（A4、2026-09-23）。文は窓の題、
   * 説明は「内容」の下の行。［詳しく］の行は開くまで窓に出ない
   */
  function answering(answer: string | undefined): void {
    picker?.restore();
    picker = answerConfirms((confirm) => {
      shown.push({ message: confirm.title, rows: confirm.rows, more: confirm.more });
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
      sends: "問い",
    });

    expect(ok).toBe(true);
    expect(shown).toHaveLength(0);
  });

  test("有料のAIでは、窓の本文が共通の3行になる（作者の見本）", async () => {
    const ok = await confirmPaidUsage(provider(true, "Claude"), {
      actionLabel: "プロットの相談",
      model: "claude-sonnet-5-5",
      sends: "プロットと直近の会話",
      bodyNotSent: true,
      more: ["（この確認はこの画面で一度だけです）"],
    });

    expect(ok).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0].message).toContain("プロットの相談");
    expect(shown[0].rows).toEqual([
      "Claude（有料）で送ります",
      "送るもの：プロットと直近の会話（本文は送りません）",
      "料金：送るたびに、使った量だけかかります",
    ]);
  });

  test("モデル名と料金の細かい断りは［詳しく］に残る（消さない）", async () => {
    await confirmPaidUsage(provider(true), {
      actionLabel: "作品紹介文の生成",
      model: "claude-sonnet-5",
      sends: "作品の概要",
      more: ["（この確認はこの画面で一度だけです）"],
    });

    const body = shown[0].rows.join("");
    const more = shown[0].more.join("");
    // どのサービスかは1行目に、どのモデルかは［詳しく］にある
    expect(body).toContain("Claude API（有料）で送ります");
    expect(body).not.toContain("claude-sonnet-5");
    expect(more).toContain("使うモデル：claude-sonnet-5");
    expect(more).toContain("トークンを消費");
    expect(more).toContain("実際の金額はモデル・実使用量・各社の現行料金によって変わります。");
    expect(more).toContain("この確認はこの画面で一度だけです");
  });

  test("呼び出し回数が分かるときは、3行目に入れる", async () => {
    await confirmPaidUsage(provider(true), {
      actionLabel: "プロットの逆算",
      model: "claude-sonnet-5",
      calls: 1,
      sends: "各話あらすじ",
    });

    expect(shown[0].rows[2]).toBe("料金：AIを 1 回呼びます。使った量だけかかります");
  });

  test("断られたら実行しない", async () => {
    answering(undefined);

    const ok = await confirmPaidUsage(provider(true), {
      actionLabel: "AIへの相談",
      model: "claude-sonnet-5",
      sends: "問い",
    });

    expect(ok).toBe(false);
  });
});
