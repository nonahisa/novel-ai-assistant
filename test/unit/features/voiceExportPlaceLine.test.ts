import { describe, expect, it } from "vitest";
import { voiceExportPlaceLine } from "../../../src/features/voiceExport";

/**
 * ［音声に書き出す］の確認の窓の「置き場」の行（1.0.8）。
 *
 * **再現したいこと**（ノートPC 2026-11-15）：「置き場：.aiwriter/exports/音声/episode_0016_長い坂道/」の
 * 1語の道を、確認の窓が窓の幅に余裕があっても「…episode_0016_長い」「坂道/」と話の名前の途中で
 * 折り返した。入れ物の道と話のフォルダーの名前を分け、切れる所を作る
 */
describe("確認の窓の置き場の行", () => {
  it("入れ物の道と話のフォルダーの名前を分けて書く（話の名前を1語の道の中に置かない）", () => {
    const line = voiceExportPlaceLine(".aiwriter/exports/音声/episode_0016_長い坂道");
    expect(line).toBe("置き場：.aiwriter/exports/音声 の中の「episode_0016_長い坂道」");
    expect(line).not.toContain("音声/episode_0016");
  });

  it("区切りの無い道は、そのまま書く", () => {
    expect(voiceExportPlaceLine("音声")).toBe("置き場：音声/");
  });
});
