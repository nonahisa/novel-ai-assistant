import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 本文の「その行」へ飛ぶ道（設計書6.37.4）。
 *
 * **ここで見るのは「降りた枝が記録に残るか」だけである。** 年表から話を
 * 押しても何も起きず、通知もログも1行も無くて原因を追えなかった
 * （実機で発見、2026-09-05）。飛べたか飛べなかったかより先に、
 * 「どこで止まったか」が残っていることを守る。
 */

const logged: string[] = [];
vi.mock("../../src/core/logger", () => ({
  logStep: (message: string) => {
    logged.push(message);
  },
}));

const { revealTextLocation } = await import("../../src/features/revealLocation");

beforeEach(() => {
  logged.length = 0;
});

describe("飛び先の記録", () => {
  it("場所が空なら、原稿エディタを呼ばずに理由を残す", async () => {
    const reveal = vi.fn(async () => true);
    await revealTextLocation("", 1, reveal, "年表");

    expect(reveal).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("年表");
    expect(logged[0]).toContain("空");
  });

  it("原稿エディタが引き受けたときも、1行残す", async () => {
    await revealTextLocation("C:/works/ijime/01.txt", 12, async () => true, "年表");

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("C:/works/ijime/01.txt");
    expect(logged[0]).toContain("12行目");
  });
});
