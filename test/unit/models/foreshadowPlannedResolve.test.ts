import { describe, expect, test } from "vitest";
import {
  emptyForeshadow,
  FORESHADOW_SCHEMA_VERSION,
  normalizeForeshadow,
  parseForeshadow,
} from "../../../src/models/foreshadow";

/**
 * 回収予定の話（設計書6.35。作者の依頼、2026-09-23「伏線とも連携させてください」）。
 *
 * **作者だけが書く項目である**（`authorNotes` と同じ扱い）。ここでは
 * 読み込みの形——欠けていれば null、壊れていれば止まる——を見る。
 * AIの検知・回収確認が書かないことは、ストアの試験
 * （`test/unit/core/foreshadowPlannedResolveStore.test.ts`）が見る。
 */
describe("回収予定の話を読む", () => {
  test("新しく作る伏線は、回収予定が未定（null）", () => {
    expect(emptyForeshadow("foreshadow_001", "銀の懐中時計").plannedResolveChapter).toBeNull();
  });

  test("旧い台帳（項目が無い）は null として読む", () => {
    // 0.1 の台帳には項目そのものが無い。**欠けただけで止めない**
    const parsed = parseForeshadow({
      schemaVersion: "0.1",
      id: "foreshadow_001",
      label: "銀の懐中時計",
    });
    expect(parsed.plannedResolveChapter).toBeNull();
  });

  test("書いてあれば、そのまま読む", () => {
    const parsed = parseForeshadow({
      id: "foreshadow_001",
      label: "銀の懐中時計",
      plannedResolveChapter: 12,
    });
    expect(parsed.plannedResolveChapter).toBe(12);
  });

  test("数でも null でもなければ止まる（勝手に直さない）", () => {
    expect(() =>
      parseForeshadow({
        id: "foreshadow_001",
        label: "銀の懐中時計",
        plannedResolveChapter: "12話",
      })
    ).toThrow(/plannedResolveChapter/);
  });

  test("補うときも null を入れる（undefined を残さない）", () => {
    const normalized = normalizeForeshadow({ id: "foreshadow_001", label: "a" });
    expect(normalized.plannedResolveChapter).toBeNull();
  });

  test("台帳の版を上げてある（項目を足したので）", () => {
    expect(FORESHADOW_SCHEMA_VERSION).toBe("0.2");
  });
});
