import { describe, expect, test } from "vitest";
import { formatModelContext } from "../../src/ai/registry";
import type { ModelInfo } from "../../src/ai/types";

/**
 * モデル選択に出す文脈の表示（作者の報告、2026-08-29：
 * 「LM Studioで『文脈 8k』と出てしまう」）。
 *
 * LM Studioは**読み込んでいないモデルも一覧に返す**。その文脈長は
 * 読み込むときに決まるのでまだ分からず、以前はここに設定値（既定8192）が
 * 出ていた。131072まで読めるモデルが「文脈 8k」と表示されていたのは
 * これが理由である。
 *
 * **`contextWindow` そのものは変えない。** 本文の分割に使う値で、
 * 実際より大きく見積もると入力が黙って切り捨てられる。表示だけを分ける。
 */

function model(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    id: "test-model",
    displayName: "test-model",
    contextWindow: 8192,
    parameterSize: null,
    capabilities: [],
    tier: "standard",
    ...overrides,
  };
}

describe("モデル選択の文脈表示", () => {
  test("未読込のモデルは、最大と「選ぶと読み込みます」を出す", () => {
    const label = formatModelContext(
      model({ loaded: false, maxContextWindow: 131072, contextWindow: 8192 })
    );

    expect(label).toContain("最大128k");
    expect(label).toContain("選ぶと読み込みます");
    // 設定値をそのまま出さない。これが「文脈 8k」の正体だった
    expect(label).not.toBe("文脈 8k");
  });

  test("読み込み済みのモデルは、実測をそのまま出す", () => {
    const label = formatModelContext(
      model({ loaded: true, maxContextWindow: 131072, contextWindow: 131072 })
    );

    expect(label).toBe("文脈 128k");
  });

  test("ほかのAIの表示は変えない", () => {
    // `loaded` も `maxContextWindow` も入れないプロバイダが大半である
    expect(formatModelContext(model({ contextWindow: 200000 }))).toBe(
      "文脈 195k"
    );
  });

  test("読み込み状況が分からないときは、これまでどおり出す", () => {
    // 口の無い古いLM Studio。**「未読込」と断じない**
    expect(
      formatModelContext(model({ maxContextWindow: 131072, contextWindow: 8192 }))
    ).toBe("文脈 8k");
  });
});
