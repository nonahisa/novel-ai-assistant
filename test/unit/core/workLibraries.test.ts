import { describe, expect, test } from "vitest";
import {
  foldersToProbeForGit,
  groupWorksByLibrary,
} from "../../../src/core/workLibraries";
import { folderKeyForComparison } from "../../../src/core/paths";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 作品一覧を書庫ごとに分ける見分け方（設計書6.97.7）。
 * git は呼ばず、`.git` の在るフォルダーを集合で受け取る。
 */

function work(id: string, folderPath: string): WorkEntry {
  return { id, title: id, folderPath, registeredAt: "2026-10-19T00:00:00.000Z" };
}

function gitSet(...folders: string[]): Set<string> {
  return new Set(folders.map((f) => folderKeyForComparison(f)));
}

describe("groupWorksByLibrary", () => {
  test("書庫が2つあれば、書庫の名前順に分け、単独の作品は後ろへ回す", () => {
    const works = [
      work("solo", "C:/solo/作品S"),
      work("b1", "C:/novels/B書庫/b1"),
      work("a1", "C:/novels/A書庫/a1"),
      work("a2", "C:/novels/A書庫/a2"),
      work("b2", "C:/novels/B書庫/b2"),
    ];
    const layout = groupWorksByLibrary(works, gitSet());
    expect(layout.libraries.map((l) => l.name)).toEqual(["A書庫", "B書庫"]);
    expect(layout.libraries[0].works.map((w) => w.id)).toEqual(["a1", "a2"]);
    expect(layout.libraries[1].works.map((w) => w.id)).toEqual(["b1", "b2"]);
    expect(layout.standalone.map((w) => w.id)).toEqual(["solo"]);
  });

  test("書庫が1つなら見出しを出さず、登録簿の順のまま", () => {
    const works = [
      work("x", "C:/solo/X"),
      work("a1", "C:/novels/A/a1"),
      work("a2", "C:/novels/A/a2"),
    ];
    const layout = groupWorksByLibrary(works, gitSet());
    expect(layout.libraries).toEqual([]);
    expect(layout.standalone.map((w) => w.id)).toEqual(["x", "a1", "a2"]);
  });

  test("書庫が0なら全部が単独", () => {
    const works = [work("a", "C:/p/a"), work("b", "C:/q/b")];
    const layout = groupWorksByLibrary(works, gitSet());
    expect(layout.libraries).toEqual([]);
    expect(layout.standalone).toHaveLength(2);
  });

  test("1つ上に .git が在れば、作品が1つでも書庫になる", () => {
    const works = [
      work("a1", "C:/novels/A/a1"),
      work("b1", "C:/novels/B/b1"),
      work("c1", "C:/other/c1"),
    ];
    const layout = groupWorksByLibrary(works, gitSet("C:/novels/A", "C:/novels/B"));
    expect(layout.libraries.map((l) => l.name)).toEqual(["A", "B"]);
    expect(layout.standalone.map((w) => w.id)).toEqual(["c1"]);
  });

  test("作品フォルダー自身に .git が在れば単独（同じ親に2つ並んでいても）", () => {
    const works = [
      work("a1", "C:/novels/A/a1"),
      work("a2", "C:/novels/A/a2"),
      work("b1", "C:/novels/B/b1"),
      work("b2", "C:/novels/B/b2"),
    ];
    // a2 は作品ごとのリポジトリ → A には a1 だけが残り、A は書庫でなくなる
    const layout = groupWorksByLibrary(works, gitSet("C:/novels/A/a2"));
    expect(layout.libraries).toEqual([]);
    expect(layout.standalone.map((w) => w.id)).toEqual(["a1", "a2", "b1", "b2"]);
  });

  test("大文字小文字・末尾の区切りの違いは同じ書庫として数える", () => {
    const works = [
      work("a1", "C:/Novels/A/a1"),
      work("a2", "c:/novels/a/a2/"),
      work("b1", "C:/novels/B/b1"),
      work("b2", "C:/novels/B/b2"),
    ];
    const layout = groupWorksByLibrary(works, gitSet());
    expect(layout.libraries).toHaveLength(2);
    expect(layout.libraries[0].works).toHaveLength(2);
  });
});

describe("foldersToProbeForGit", () => {
  test("作品とその1つ上を、重ねずに挙げる", () => {
    const works = [work("a1", "C:/novels/A/a1"), work("a2", "C:/novels/A/a2")];
    const probes = foldersToProbeForGit(works);
    expect(probes).toHaveLength(3);
    expect(new Set(probes.map((p) => p.key)).size).toBe(3);
  });
});
