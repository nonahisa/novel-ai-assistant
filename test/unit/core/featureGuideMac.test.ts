import { describe, expect, test, vi } from "vitest";
import { INDEX_CHAR_LIMIT } from "../support/featureIndexLimit";

/**
 * Mac の書き方の目次も、同じ上限に収まるか。
 *
 * Mac では「右クリック」に「（Mac は control＋クリック）」が添わる（`core/keyLabels.ts`）。
 * 入口の名前（`core/actionEntrance.ts`）は読み込んだ時に一度だけ直すので、Windows で
 * 走らせた検査は Mac の長さを見ていなかった。2026-11-18、Windows で 2,999字・Mac で 3,019字になり、
 * Mac の単体テストだけが落ちた。どの機械で走らせても Mac の形を見るよう、ここで Mac に見せかける。
 */
vi.mock("../../../src/core/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/core/runtime")>();
  return { ...real, isMacHost: () => true };
});

describe("Mac の書き方の目次", () => {
  test("Mac の添え書きが入っている（見せかけが効いている）", async () => {
    const { buildFeatureIndex } = await import("../../../src/core/featureGuide");
    expect(buildFeatureIndex("author")).toContain("（Mac は control＋クリック）");
  });

  test.each(["author", "editor"] as const)("%s モードの目次も上限に収まる", async (mode) => {
    const { buildFeatureIndex } = await import("../../../src/core/featureGuide");
    const index = buildFeatureIndex(mode);
    expect(index.length, `Mac の ${mode} モードの目次 ${index.length}字`).toBeLessThan(INDEX_CHAR_LIMIT);
  });
});
