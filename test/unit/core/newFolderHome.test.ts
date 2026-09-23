import { describe, expect, it } from "vitest";
import {
  isInsideAnyWork,
  newFolderHomeCandidates,
} from "../../src/core/newFolderHome";
import { isSameLocation } from "../../src/core/locationCompare";

/**
 * 「新しい置き場を作る」ときの既定の場所（設計書6.97.6）。
 *
 * **実機で見つかった不具合の再現。** 2026-09-21、ノートPCで
 * 「GitHubから作品を追加」を押すと、フォルダー選択の窓が
 * `…\novels\novels\初恋相手の王女…`——**作者の原稿フォルダーの中**を
 * 開いた状態で立ち上がった。`defaultUri` を渡していないと、VS Codeは
 * 最後に使った場所を出す。そのまま押せば原稿の中に書庫が入る。
 *
 * ここで確かめるのは**「作品フォルダーの中を既定にしない」**こと。
 *
 * **場所は `isSameLocation` で比べる。** 返る文字列はOSの区切り
 * （Windowsなら円記号）に直されているので、書いたとおりの綴りでは
 * 一致しない。
 */

/** 実機で起きた並び（書庫の中に作品が並ぶ）を、そのまま写した */
const LIBRARY = "C:/Users/nonah/Documents/novels/novels";
/** 書庫の1つ上。ここが既定であってほしい */
const ABOVE_LIBRARY = "C:/Users/nonah/Documents/novels";
const WORKS = [
  { folderPath: `${LIBRARY}/初恋相手の王女` },
  { folderPath: `${LIBRARY}/いじめられっ子` },
];

/** 一覧の中に、その場所が入っているか（区切りと大文字小文字を揃えて見る） */
function includesLocation(
  candidates: readonly string[],
  location: string
): boolean {
  return candidates.some((candidate) => isSameLocation(candidate, location));
}

describe("新しい置き場の既定", () => {
  it("作品フォルダーの中を既定にしない", () => {
    const candidates = newFolderHomeCandidates({ works: WORKS });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(
        isInsideAnyWork(candidate, WORKS),
        `作品の中が既定になっている: ${candidate}`
      ).toBe(false);
    }
  });

  it("書庫の中も既定にしない（リポジトリの入れ子になる）", () => {
    // 書庫は1つのリポジトリ（5.7）。その中へ取り寄せると入れ子になる
    const candidates = newFolderHomeCandidates({ works: WORKS });

    expect(isSameLocation(candidates[0], ABOVE_LIBRARY)).toBe(true);
    expect(includesLocation(candidates, LIBRARY)).toBe(false);
  });

  it("書庫が分かれていれば、作品の多いほうの親を先に出す", () => {
    const candidates = newFolderHomeCandidates({
      works: [...WORKS, { folderPath: "D:/わき道/単発/短編" }],
    });

    expect(isSameLocation(candidates[0], ABOVE_LIBRARY)).toBe(true);
    expect(includesLocation(candidates, "D:/わき道")).toBe(true);
  });

  it("同じ場所を二度出さない", () => {
    // 書庫が2つ並んでいると、親は同じ1つになる
    const candidates = newFolderHomeCandidates({
      works: [
        { folderPath: "C:/小説/書庫A/作品1" },
        { folderPath: "C:/小説/書庫B/作品2" },
      ],
    });

    expect(
      candidates.filter((c) => isSameLocation(c, "C:/小説"))
    ).toHaveLength(1);
  });

  it("書庫の親が作品の中なら、そこは飛ばす", () => {
    // 作品の中にもう1つ作品を作ってしまっている作者が居ても、
    // **その内側を既定にはしない**
    const works = [
      { folderPath: "C:/Users/nonah/小説/親作品" },
      { folderPath: "C:/Users/nonah/小説/親作品/書庫/子作品" },
    ];
    const candidates = newFolderHomeCandidates({ works });

    expect(includesLocation(candidates, "C:/Users/nonah/小説/親作品")).toBe(
      false
    );
    expect(isSameLocation(candidates[0], "C:/Users/nonah")).toBe(true);
  });

  it("ドライブの直下は既定にしない", () => {
    // 作品が根の近くにあると、書庫の親が `C:\` になる。そこを開いて
    // 見せられても、作者はどこへ置けばよいのか分からない
    const candidates = newFolderHomeCandidates({
      works: [{ folderPath: "C:/小説/作品" }],
    });

    expect(candidates).toEqual([]);
  });

  it("作品がまだ無ければ、開いているフォルダーを使う", () => {
    const candidates = newFolderHomeCandidates({
      works: [],
      workspaceFolders: ["C:/Users/nonah/Documents"],
    });

    expect(candidates).toEqual(["C:/Users/nonah/Documents"]);
  });

  it("開いているフォルダーが作品そのものなら使わない", () => {
    const inside = `${LIBRARY}/初恋相手の王女`;
    const candidates = newFolderHomeCandidates({
      works: WORKS,
      workspaceFolders: [inside],
    });

    expect(includesLocation(candidates, inside)).toBe(false);
  });

  it("手がかりが無ければ、既定を出さない", () => {
    // 当てずっぽうの場所を出すより、VS Codeに任せるほうがまし
    expect(newFolderHomeCandidates({ works: [] })).toEqual([]);
  });
});

describe("作品の中かどうか", () => {
  it("作品フォルダーそのものも「中」として扱う", () => {
    expect(isInsideAnyWork(`${LIBRARY}/初恋相手の王女`, WORKS)).toBe(true);
  });

  it("名前が前方一致しているだけのフォルダーは「外」", () => {
    // 「いじめられっ子」の中に「いじめ」は入っていない
    expect(isInsideAnyWork(`${LIBRARY}/いじめ`, WORKS)).toBe(false);
  });
});
