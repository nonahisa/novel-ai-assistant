import { describe, expect, test } from "vitest";
import { tuningOfferMessage } from "../../../src/core/tuningOffer";

/**
 * AIチューニングの「設定に反映」を訊く知らせは、要点を先頭に出す
 * （実機確認リスト D-1「AIチューニングの結果の通知は長い（10行以上）」）。
 *
 * それまでは、測った経過（打ち切りの理由・字/トークン・時間のかかった回…）が
 * 先に並び、**何をどのモデルへ反映するのか**が最後の数行にあった。通知は
 * 先頭の数行しか見えないので、作者は通知センターを開かないと「押すと何が
 * 変わるのか」を読めなかった。
 */
const LONG_SUMMARY =
  "読める長さは 12,000字 まで通りました。".repeat(6) +
  "いちばん時間がかかった回は 95 秒でした。";

describe("反映を訊く知らせの並び", () => {
  const message = tuningOfferMessage({
    cancelled: false,
    modelKey: "ollama/gemma4:e4b",
    apply: ["読める長さ 約8,600トークン", "待ち時間 300秒"],
    summary: LONG_SUMMARY,
    notes: ["読める長さそのものは、このAIが申告する値を使い続けます。"],
  });

  test("どのモデルへ何を反映するかが、経過より前にある", () => {
    const head = message.indexOf("ollama/gemma4:e4b");
    expect(head).toBeGreaterThanOrEqual(0);
    expect(head).toBeLessThan(message.indexOf(LONG_SUMMARY));
    expect(message.indexOf("待ち時間 300秒")).toBeLessThan(message.indexOf(LONG_SUMMARY));
    // 先頭の1文で用が足りる長さ（通知の1行目に収まる目安）
    expect(message.indexOf("。")).toBeLessThan(80);
  });

  test("書き先（保管庫であって VS Code の設定ではない）と、ほかのモデルへの影響は言う", () => {
    // 作者が settings.json を見に行き「何も起きていない」と受け取った（2026-09-19）
    expect(message).toContain("model-tuning.json");
    expect(message).toContain("VS Code の設定ではありません");
    expect(message).toContain("ほかのモデルには影響しません");
  });

  test("反映する値を2度並べない", () => {
    expect(message.split("待ち時間 300秒").length - 1).toBe(1);
  });

  /** 書ける量も1文目に出す（作者の裁定、2026-10-03）。押す前に記録してある */
  test("記録済みの値（書ける量）も、1文目の中に並べる", () => {
    const withOutput = tuningOfferMessage({
      cancelled: false,
      modelKey: "ollama/gemma4:e4b",
      apply: ["待ち時間 300秒"],
      recorded: ["書ける量 約9,645トークン（記録済み）"],
      summary: LONG_SUMMARY,
      notes: [],
    });
    const head = withOutput.slice(0, withOutput.indexOf("。") + 1);
    expect(head).toContain("待ち時間 300秒");
    expect(head).toContain("書ける量 約9,645トークン（記録済み）");
  });

  test("中止したときは、先頭でそう言う", () => {
    const cancelled = tuningOfferMessage({
      cancelled: true,
      modelKey: "ollama/x",
      apply: ["待ち時間 60秒"],
      summary: "経過。",
      notes: [],
    });
    expect(cancelled.startsWith("（途中で中止しました）")).toBe(true);
  });
});
