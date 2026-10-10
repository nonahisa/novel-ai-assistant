import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { TYPO_MODEL_ADVICE } from "../../../src/core/requirements";

/**
 * Ollama の導入画面で、モデルを取る前に添える誤字脱字の案内（作者の裁定 2026-09-06）。
 *
 * **既定は変えない。** 勝手に重いモデルへ切り替えると、非力な機械で
 * 動かなくなる。
 *
 * 機能別AI割当の画面には出さない（作者の裁定 2026-10-10「割当画面の案内も
 * 外してください」。`test/unit/cross/smallModelNoticeRemoved.test.ts`）。
 * 文言は `src/core/requirements.ts` の1か所が持ち、導入画面が読む。
 */
function read(relative: string): string {
  return readFileSync(
    path.join(__dirname, "..", "..", "..", "src", relative),
    "utf8"
  );
}

describe("誤字脱字に向くモデルの案内（Ollama の導入画面）", () => {
  test("手元の大きいモデルと、外部AIの両方を挙げる", () => {
    // 「26bにする」だけでは、鍵を持っている作者の道が閉じる。
    // 2026-09-26 の比べ（確実19件）で 12b は5件だったので、勧めを 26b へ上げた
    expect(TYPO_MODEL_ADVICE).toContain("gemma4:26b");
    expect(TYPO_MODEL_ADVICE).not.toContain("gemma4:12b 以上");
    expect(TYPO_MODEL_ADVICE).toContain("Kimi-K2.6");
    // 何を見逃すのか・どれだけ違うのかを数で言う（言わないと、勧めの理由が伝わらない）
    expect(TYPO_MODEL_ADVICE).toMatch(/4B|4b/);
    expect(TYPO_MODEL_ADVICE).toContain("19件");
    expect(TYPO_MODEL_ADVICE).toContain("2026-09-26");
    expect(TYPO_MODEL_ADVICE).not.toMatch(/26B/);
  });

  test("既定のモデルは変えない（作者の判断 2026-09-26「このまま」）", () => {
    expect(read("core/requirements.ts")).toContain('RECOMMENDED_CHAT_MODEL = "gemma4:e4b"');
  });

  test("Ollamaのセットアップの説明が、この定数を読む", () => {
    const source = read("features/setupOllama.ts");
    expect(source).toContain("TYPO_MODEL_ADVICE");
    expect(source).not.toContain("gemma4:26b");
    expect(source).not.toContain("Kimi-K2.6");
  });
});
