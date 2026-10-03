import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ scheme: "file", fsPath: p, path: p }),
    parse: (value: string) => ({ scheme: "x", fsPath: value, path: value }),
  },
}));

import { libraryLogCandidates, syncLogPlace } from "../../../src/core/syncTarget";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 書庫の同期の記録を、書庫のログ1つへ（作者の裁定、2026-10-03。設計書5.7.9）。
 *
 * 以前は置き場の先頭の作品（`works[0]`）のログへ書いていた。
 */

function work(title: string, folderPath: string): WorkEntry {
  return {
    id: title,
    title,
    folderPath,
    registeredAt: "2026-10-03T00:00:00.000Z",
  };
}

const library = "C:/書庫";
const a = work("いじめられっ子", "C:/書庫/いじめられっ子");
const b = work("ハイエルフ未亡人", "C:/書庫/ハイエルフ未亡人");

describe("同期の記録の書き先", () => {
  it("書庫なら、先頭の作品ではなく書庫の直下", () => {
    expect(syncLogPlace(library, [a, b])).toEqual({
      folder: library,
      library: true,
    });
  });

  it("書庫に1作品しか登録していなくても書庫の直下（足したとたんに場所を変えない）", () => {
    expect(syncLogPlace(library, [a])).toEqual({ folder: library, library: true });
  });

  it("作品ごとに分けたリポジトリなら、これまでどおり作品のログ", () => {
    expect(syncLogPlace("C:/書庫/いじめられっ子/", [a])).toEqual({
      folder: a.folderPath,
      library: false,
    });
  });

  it("作品が1つも無い置き場（設定の途中）では向けない", () => {
    expect(syncLogPlace(library, [])).toBeUndefined();
  });
});

describe("掃除の対象にする書庫の直下", () => {
  it("作品の親を重ねずに並べ、作品そのものは外す", () => {
    const solo = work("単独", "D:/単独作品");
    const nested = work("入れ子", "D:/単独作品/外伝");
    expect(libraryLogCandidates([a, b, solo, nested])).toEqual([library, "D:/"]);
  });
});
