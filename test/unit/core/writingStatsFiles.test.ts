import { describe, expect, test } from "vitest";
import {
  collectWritingStats,
  isWritingStatsFileName,
  parseWritingStatsFile,
} from "../../../src/core/writingStatsFiles";

/**
 * 執筆量の記録ファイルの読み方（`WritingStatsStore` から切り出したもの。2026-10-16）。
 * 製品（vscode のファイル操作）と MCP の読む口（Node の fs）が同じ関数を通す。
 */
describe("執筆量の記録ファイルの読み方", () => {
  const record = (deviceId: string, net: number) =>
    JSON.stringify({ schemaVersion: "1", deviceId, days: [{ date: "2026-10-16", net, gross: net, saves: 1 }] });

  test("壊れた記録は投げずに undefined（競合マーカー・知らない版）", () => {
    expect(parseWritingStatsFile("<<<<<<< HEAD\n{")).toBeUndefined();
    expect(parseWritingStatsFile(JSON.stringify({ schemaVersion: "9", deviceId: "a", days: [] }))).toBeUndefined();
    expect(parseWritingStatsFile(record("desk", 10))?.deviceId).toBe("desk");
  });

  test("壊れたもの・.json でないものを飛ばし、環境の名前の順に並べる", () => {
    const sets = collectWritingStats([
      { name: "note-pc.json", text: record("note-pc", 1) },
      { name: "broken.json", text: "{" },
      { name: "memo.txt", text: record("memo", 1) },
      { name: "desk.json", text: record("desk", 2) },
    ]);
    expect(sets.map((set) => set.deviceId)).toEqual(["desk", "note-pc"]);
  });

  test("記録のファイルとして読むのは .json だけ", () => {
    expect(isWritingStatsFileName("desk.json")).toBe(true);
    expect(isWritingStatsFileName("desk.json.bak")).toBe(false);
  });
});
