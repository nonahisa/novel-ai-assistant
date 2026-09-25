import { describe, expect, test } from "vitest";
import {
  newlySelectedModels,
  nudgeTuningMessage,
  selectedModelKey,
  shouldNudgeTuning,
  type SelectedModel,
} from "../../../src/core/tuningNudge";

/**
 * 測っていないモデルに切り替えたら、AIチューニングを一言勧める
 * （設計書6.49.8。作者の判断、2026-09-26）。
 *
 * **しつこくしない**のが作者の条件である——同じモデルは一度だけ、
 * 「今後出さない」も効く、前から使っているモデルのことは言わない。
 */

const E4B: SelectedModel = {
  providerId: "ollama",
  model: "gemma4:e4b",
  feature: "default",
};
const TWELVE: SelectedModel = {
  providerId: "ollama",
  model: "gemma4:12b",
  feature: "typo",
};

describe("新しく使われ始めたモデルだけ", () => {
  test("割当で増えたモデルを返す", () => {
    expect(newlySelectedModels([E4B], [E4B, TWELVE])).toEqual([TWELVE]);
  });

  test("前から使っているモデルは返さない（別の機能の割当を替えただけ）", () => {
    const chat: SelectedModel = { ...E4B, feature: "chat" };
    expect(newlySelectedModels([E4B], [E4B, chat])).toEqual([]);
  });

  test("同じモデルが2つの機能で使われ始めても、1度だけ返す", () => {
    const proofread: SelectedModel = { ...TWELVE, feature: "proofread" };
    expect(newlySelectedModels([E4B], [E4B, TWELVE, proofread])).toEqual([
      TWELVE,
    ]);
  });

  test("割当を外しただけなら何も返さない", () => {
    expect(newlySelectedModels([E4B, TWELVE], [E4B])).toEqual([]);
  });
});

describe("勧めるか", () => {
  const empty = new Set<string>();

  test("測っていない・まだ勧めていない・止められていない → 勧める", () => {
    expect(
      shouldNudgeTuning(TWELVE, { tuned: false, shown: empty, muted: false })
    ).toBe(true);
  });

  test("同じモデルは一度だけ（機能が違っても）", () => {
    const shown = new Set([selectedModelKey(TWELVE)]);
    expect(
      shouldNudgeTuning(
        { ...TWELVE, feature: "proofread" },
        { tuned: false, shown, muted: false }
      )
    ).toBe(false);
  });

  test("測ってあれば勧めない", () => {
    expect(
      shouldNudgeTuning(TWELVE, { tuned: true, shown: empty, muted: false })
    ).toBe(false);
  });

  test("「今後出さない」を押していれば勧めない", () => {
    expect(
      shouldNudgeTuning(TWELVE, { tuned: false, shown: empty, muted: true })
    ).toBe(false);
  });

  test("鍵はAIチューニングの台帳と同じ形（プロバイダ/モデル）", () => {
    expect(selectedModelKey(TWELVE)).toBe("ollama/gemma4:12b");
  });
});

describe("知らせの文", () => {
  test("測っていないこと・測ると何が合うかを言う", () => {
    const message = nudgeTuningMessage({
      providerName: "Ollama",
      model: "gemma4:12b",
      isPaid: false,
    });
    expect(message).toContain("Ollama（gemma4:12b）はまだ測っていません");
    expect(message).toContain("待ち時間や読める長さ");
    // 無料のAIに料金の話を出さない
    expect(message).not.toContain("料金");
  });

  test("有料のAIでは、測ると料金がかかることを添える", () => {
    const message = nudgeTuningMessage({
      providerName: "Claude",
      model: "claude-sonnet",
      isPaid: true,
    });
    expect(message).toContain("Claude は有料です");
    expect(message).toContain("料金がかかります");
  });

  test("有料か分からないときは「無料」へ倒さず、条件つきで添える", () => {
    const message = nudgeTuningMessage({
      providerName: "unknown",
      model: "m",
      isPaid: undefined,
    });
    expect(message).toContain("有料のAIでは、その回数ぶん料金がかかります");
  });
});
