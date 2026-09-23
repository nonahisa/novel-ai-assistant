import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isConnectivityFailure, isFatalProviderFailure } from "../../src/ai/types";

/**
 * 「待っても直らない失敗」で、残りのチャンクを試すのをやめる。
 *
 * **実際に起きた**（2026-08-30の作者のログ）。載らない大きさのモデル
 * （`gemma4:26b`、19GB／この機械はVRAM 8GB）のまま伏線の回収確認を回し、
 * **9チャンクすべてが同じ `model_load_failed` で失敗**していた。
 * 誤字脱字と人物抽出には中断の判定があったが、**伏線・推敲・矛盾検知には
 * 無く**、環境側の失敗でも全チャンクを回し切っていた。
 */
describe("待っても直らない失敗の判定", () => {
  test("環境側の失敗は、続けても同じなので中断の対象", () => {
    for (const kind of [
      "authentication_failed",
      "permission_denied",
      "insufficient_credit",
      "model_load_failed",
      "rate_limited",
    ] as const) {
      expect(isFatalProviderFailure(kind)).toBe(true);
    }
  });

  test("一時的な失敗は中断しない（回数を数えて判断する側の仕事）", () => {
    // ここを増やすと、繋がらなかっただけで残りを捨てることになる
    for (const kind of ["timeout", "not_running"] as const) {
      expect(isFatalProviderFailure(kind)).toBe(false);
      expect(isConnectivityFailure(kind)).toBe(true);
    }
  });

  test("チャンクの中身が原因の失敗は中断しない", () => {
    // 次のチャンクなら通ることがある。ここで止めると本文の大半を見ずに終わる
    for (const kind of [
      "bad_response",
      "context_overflow",
      "model_not_found",
      "unknown",
    ] as const) {
      expect(isFatalProviderFailure(kind)).toBe(false);
    }
  });
});

/**
 * **本文をチャンクで回す機能は、全部この判定を通す。**
 *
 * 5つのうち2つにしか無かったために、伏線の回収確認が同じ失敗を9件積んだ。
 * 6つ目を足した人が同じ穴を開けないよう、機械に見張らせる。
 */
describe("チャンクを回す機能は中断の判定を持つ", () => {
  const FEATURES = [
    "checkTypos.ts",
    "checkProofread.ts",
    "checkContradictions.ts",
    "checkForeshadows.ts",
    "extractCharacters.ts",
  ];

  for (const name of FEATURES) {
    const source = readFileSync(
      resolve(__dirname, "../../src/features", name),
      "utf8"
    );

    test(`${name} は待っても直らない失敗で残りを試さない`, () => {
      expect(source).toContain("isFatalProviderFailure");
    });

    test(`${name} は判定の写しを持たない`, () => {
      // 写しがあると、片方だけ直して気づかない（CLAUDE.md「写しを作らない」）
      expect(source).not.toMatch(/function isFatalProviderFailure/);
      expect(source).not.toMatch(/function isConnectivityFailure/);
    });
  }
});
