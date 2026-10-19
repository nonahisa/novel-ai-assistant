import { describe, expect, test } from "vitest";
import {
  paidCostLines,
  paidHeadLine,
  paidPriceLine,
  paidUsageNotice,
} from "../../../src/core/paidUsageNotice";

/**
 * 有料のAIを使う前の確かめの窓は、課金の機能で共通の3行（作者の裁定
 * 2026-10-19「確認画面はもう少しシンプルに」「3行にする」「課金の機能で
 * 共通にしてください」。設計書7.1.1）。
 *
 * 作者が選んだ見本：
 *   Claude（有料）で送ります
 *   送るもの：プロットと直近の会話（本文は送りません）
 *   料金：送るたびに、使った量だけかかります
 */
describe("有料のAIの確かめの3行", () => {
  test("作者の見本どおりの3行になる（プロットの相談）", () => {
    const notice = paidUsageNotice("Claude", "claude-sonnet-5-5", {
      sends: "プロットと直近の会話",
      bodyNotSent: true,
    });
    expect(notice.lines).toEqual([
      "Claude（有料）で送ります",
      "送るもの：プロットと直近の会話（本文は送りません）",
      "料金：送るたびに、使った量だけかかります",
    ]);
  });

  test("呼ぶ回数が分かる機能は、3行目に回数を入れる", () => {
    const notice = paidUsageNotice("Google Gemini", "gemini-2.5-flash", {
      sends: "第1話の冒頭 1,200字",
      calls: 1,
    });
    expect(notice.lines).toEqual([
      "Google Gemini（有料）で送ります",
      "送るもの：第1話の冒頭 1,200字",
      "料金：AIを 1 回呼びます。使った量だけかかります",
    ]);
  });

  test("本文を送る機能は「本文は送りません」を付けず、量は2行目に残る", () => {
    const notice = paidUsageNotice("さくらのAI", "m", {
      sends: "この話の本文 3,000字",
      calls: 4,
    });
    expect(notice.lines[1]).toBe("送るもの：この話の本文 3,000字");
    expect(notice.lines[1]).not.toContain("本文は送りません");
    expect(notice.lines[2]).toBe("料金：AIを 4 回呼びます。使った量だけかかります");
  });

  test("サービス名は渡された表示名から作る（決め打ちしない）", () => {
    const notice = paidUsageNotice("作り物のクラウドAI", "x", { sends: "s" });
    expect(notice.lines[0]).toBe("作り物のクラウドAI（有料）で送ります");
    expect(notice.lines.join("")).not.toMatch(/Claude|Gemini/);
  });

  test("表示名の末尾の性質の括弧は外す（括弧が2つ続かない）", () => {
    expect(paidHeadLine("Claude（クラウド・有料）")).toBe("Claude（有料）で送ります");
    expect(paidHeadLine("Gemini（クラウド・無料枠あり）")).toBe("Gemini（有料）で送ります");
    expect(paidHeadLine("さくらのAI（クラウド・無料枠あり）")).toBe("さくらのAI（有料）で送ります");
    expect(paidHeadLine("VS Code 経由でつなぐ")).toBe("VS Code 経由でつなぐ（有料）で送ります");
    // 括弧だけの名前は、そのまま残す（空にしない）
    expect(paidHeadLine("（名無し）")).toBe("（名無し）（有料）で送ります");
  });

  test("モデル名と料金の細かい断りは、窓の本文から外して［詳しく］へ残す", () => {
    const notice = paidUsageNotice("Claude", "claude-sonnet-5-5", {
      sends: "プロットと直近の会話",
      bodyNotSent: true,
      more: ["（この確認はこの画面で一度だけです）"],
    });
    const body = notice.lines.join("\n");
    for (const moved of [
      "claude-sonnet-5-5",
      "トークンを消費",
      "実際の金額はモデル・実使用量・各社の現行料金によって変わります。",
      "この確認はこの画面で一度だけです",
    ]) {
      expect(body).not.toContain(moved);
      expect(notice.more.join("\n")).toContain(moved);
    }
    expect(notice.more[0]).toBe("使うモデル：claude-sonnet-5-5");
  });

  test("見積もりを自前で組む確認へは、1行目と3行目だけを添える", () => {
    expect(paidCostLines("Claude", 12)).toEqual([
      "Claude（有料）で送ります",
      "料金：AIを 12 回呼びます。使った量だけかかります",
    ]);
    expect(paidPriceLine()).toBe("料金：送るたびに、使った量だけかかります");
  });
});
