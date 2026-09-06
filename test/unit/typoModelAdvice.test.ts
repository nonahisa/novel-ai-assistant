import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { TYPO_MODEL_ADVICE } from "../../src/core/requirements";

/**
 * 誤字脱字は、大きいモデルを勧める（作者の裁定 2026-09-06）。
 *
 * 実測（プロンプト設計書 P-09 の実測メモ 2026-09-06）：`gemma4:e4b`（4B）は
 * 「目を覚まさ」「思わなかつた」型の誤りを2回とも見逃し、12b は拾った。
 * **活用の誤りと促音の誤りは、モデルの大きさで結果が変わる。**
 *
 * **既定は変えない。** 勝手に重いモデルへ切り替えると、非力な機械で
 * 動かなくなる。**選ぶところで一言添えるだけ**にする。
 *
 * 文言は `src/core/requirements.ts` の1か所が持ち、
 * 機能別AI割当とOllamaのセットアップの両方が読む（写しを作らない）。
 */
function read(relative: string): string {
  return readFileSync(
    path.join(__dirname, "..", "..", "src", relative),
    "utf8"
  );
}

describe("誤字脱字に向くモデルの案内", () => {
  test("手元の大きいモデルと、外部AIの両方を挙げる", () => {
    // 「12bにする」だけでは、鍵を持っている作者の道が閉じる
    expect(TYPO_MODEL_ADVICE).toContain("gemma4:12b");
    expect(TYPO_MODEL_ADVICE).toContain("Gemini");
    // 何を見逃すのかを言う（言わないと、勧めの理由が伝わらない）
    expect(TYPO_MODEL_ADVICE).toMatch(/4B|4b/);
    expect(TYPO_MODEL_ADVICE).toContain("2026-09-06");
  });

  test("機能別AI割当の「誤字脱字」の説明が、この定数を読む", () => {
    const source = read("features/assignFeatureAI.ts");
    expect(source).toContain("TYPO_MODEL_ADVICE");
    // 写しを作らない（文言をそのまま書き込んでいない）
    expect(source).not.toContain("gemma4:12b");
  });

  test("Ollamaのセットアップの説明も、この定数を読む", () => {
    const source = read("features/setupOllama.ts");
    expect(source).toContain("TYPO_MODEL_ADVICE");
    expect(source).not.toContain("gemma4:12b");
  });
});
