import { describe, expect, it } from "vitest";
import {
  WORKS_SNAPSHOT_PATH,
  WORKS_SNAPSHOT_SCHEMA,
  buildWorksSnapshot,
  parseWorksSnapshot,
  serializeWorksSnapshot,
} from "../../../src/core/worksSnapshot";
import * as path from "../../../src/core/pathText";

/**
 * 作品の登録簿の写し（MCP の `works.list`。作者の承認、2026-09-24）。
 *
 * **見張りたいのは、写しから二重登録と書庫が読めること。** 2026-09-24 の
 * 二重登録の件は、登録簿が外から読めずにコードから推理するしかなかった。
 */

const NOW = new Date("2026-09-24T10:00:00.000Z");
const WRITER = { pid: 1234, extensionVersion: "0.85.0", machineName: "DESKTOP" };

function work(id: string, folderPath: string, title = id) {
  return { id, title, folderPath, registeredAt: "2026-09-01T00:00:00.000Z" };
}

describe("写しを組み立てる（buildWorksSnapshot）", () => {
  it("置き場は保管庫の .aiwriter/works.json", () => {
    expect(WORKS_SNAPSHOT_PATH).toEqual([".aiwriter", "works.json"]);
  });

  it("作品ID・作品名・場所・登録日を、受け取った順に写す", () => {
    const snapshot = buildWorksSnapshot(
      [work("b", "C:/小説/灯台", "灯台"), work("a", "D:/単独/海", "海")],
      WRITER,
      NOW
    );
    expect(snapshot.schema).toBe(WORKS_SNAPSHOT_SCHEMA);
    expect(snapshot.writtenAt).toBe(NOW.toISOString());
    expect(snapshot.writtenBy).toEqual(WRITER);
    expect(snapshot.works.map((entry) => [entry.id, entry.title, entry.folderPath])).toEqual([
      ["b", "灯台", "C:/小説/灯台"],
      ["a", "海", "D:/単独/海"],
    ]);
  });

  it("同じ親フォルダーに2作品以上あれば書庫。1作品だけなら書庫とは言わない", () => {
    const snapshot = buildWorksSnapshot(
      [work("a", "C:/小説/灯台"), work("b", "C:/小説/港"), work("c", "D:/単独/海")],
      WRITER,
      NOW
    );
    const byId = new Map(snapshot.works.map((entry) => [entry.id, entry]));
    expect(byId.get("a")?.inLibrary).toBe(true);
    expect(byId.get("a")?.siblingsRegistered).toBe(2);
    expect(byId.get("c")?.inLibrary).toBe(false);
    // 区切りの向きは機械の流儀に揃う（`findLibraries` と同じ割り出し方）
    expect(byId.get("c")?.parentFolder).toBe(path.dirname(path.normalize("D:/単独/海")));
    expect(snapshot.libraries).toEqual([
      { folderPath: path.dirname(path.normalize("C:/小説/灯台")), workCount: 2 },
    ]);
  });

  it("同じ場所の二重登録を挙げる（大小・末尾の区切りの違いも同じ場所）", () => {
    const snapshot = buildWorksSnapshot(
      [work("a", "C:\\小説\\灯台"), work("b", "c:\\小説\\灯台\\"), work("c", "C:\\小説\\港")],
      WRITER,
      NOW
    );
    expect(snapshot.duplicates).toEqual([{ folderPath: "C:\\小説\\灯台", ids: ["a", "b"] }]);
  });

  it("項目が欠けた記録も落とさず、空の文字で埋めて並べる", () => {
    const snapshot = buildWorksSnapshot(
      [{ id: "x", title: undefined, folderPath: undefined, registeredAt: 5 }],
      WRITER,
      NOW
    );
    expect(snapshot.works).toEqual([
      {
        id: "x",
        title: "",
        folderPath: "",
        registeredAt: "",
        parentFolder: null,
        siblingsRegistered: 1,
        inLibrary: false,
      },
    ]);
    expect(snapshot.duplicates).toEqual([]);
  });

  it("作品の中身を持たない（写しの項目は決めたものだけ）", () => {
    const snapshot = buildWorksSnapshot([work("a", "C:/小説/灯台")], WRITER, NOW);
    expect(Object.keys(snapshot.works[0]).sort()).toEqual(
      [
        "folderPath",
        "id",
        "inLibrary",
        "parentFolder",
        "registeredAt",
        "siblingsRegistered",
        "title",
      ].sort()
    );
  });
});

describe("写しを読む（parseWorksSnapshot）", () => {
  it("書いたものをそのまま読み戻せる", () => {
    const snapshot = buildWorksSnapshot(
      [work("a", "C:/小説/灯台"), work("b", "C:/小説/灯台")],
      WRITER,
      NOW
    );
    expect(parseWorksSnapshot(serializeWorksSnapshot(snapshot))).toEqual(snapshot);
  });

  it("壊れた写しは投げずに undefined。1件でも欠けていれば写しごと", () => {
    const good = buildWorksSnapshot([work("a", "C:/小説/灯台")], WRITER, NOW);
    expect(parseWorksSnapshot("{")).toBeUndefined();
    expect(parseWorksSnapshot(JSON.stringify({ ...good, schema: 2 }))).toBeUndefined();
    expect(
      parseWorksSnapshot(JSON.stringify({ ...good, works: [...good.works, { id: 1 }] }))
    ).toBeUndefined();
  });
});
