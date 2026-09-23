import { describe, expect, it } from "vitest";
import {
  existingWorkFolderHomeCandidates,
  isInsideAnyWork,
} from "../../../src/core/newFolderHome";
import { isSameLocation } from "../../../src/core/locationCompare";

/**
 * 「フォルダから追加」の選択の窓を、最初にどこで開くか（2026-09-23）。
 *
 * **実機で見つかった不具合の再現。** ノートPCの実機確認（0.77.0）で、
 * 「フォルダから追加」を押すと、窓が**選択中の作品の `設定` フォルダーの中**
 * から開いた。`defaultUri` を渡しておらず、VS Code が「最後に使った場所」を
 * 出していた。そこから別の作品フォルダーを探すには、何段も上がる必要がある。
 *
 * 既に書いてある作品フォルダーを選ぶ窓なので、新しい置き場を作るとき
 * （`newFolderHomeCandidates`、書庫の親）とは違い、**書庫そのもの**——
 * 作品フォルダーが並んでいる階層——から始める。
 */

const LIBRARY = "C:/Users/nonah/Documents/novels/novels";
const WORKS = [
  { folderPath: `${LIBRARY}/初恋相手の王女` },
  { folderPath: `${LIBRARY}/いじめられっ子` },
];

describe("フォルダから追加の窓の既定", () => {
  it("書庫（作品の置き場の親）から始める", () => {
    const candidates = existingWorkFolderHomeCandidates({ works: WORKS });
    expect(isSameLocation(candidates[0], LIBRARY)).toBe(true);
  });

  it("作品の中（`設定` など）を既定にしない", () => {
    const candidates = existingWorkFolderHomeCandidates({
      works: WORKS,
      workspaceFolders: [`${LIBRARY}/初恋相手の王女/設定`],
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(
        isInsideAnyWork(candidate, WORKS),
        `作品の中が既定になっている: ${candidate}`
      ).toBe(false);
    }
  });

  it("書庫が分かれていれば、作品の多いほうを先に出す", () => {
    const candidates = existingWorkFolderHomeCandidates({
      works: [...WORKS, { folderPath: "D:/わき道/短編" }],
    });
    expect(isSameLocation(candidates[0], LIBRARY)).toBe(true);
    expect(candidates.some((c) => isSameLocation(c, "D:/わき道"))).toBe(true);
  });

  it("作品がまだ無ければ、開いているフォルダーの先頭を使う", () => {
    const candidates = existingWorkFolderHomeCandidates({
      works: [],
      workspaceFolders: ["C:/Users/nonah/Documents", "D:/ほか"],
    });
    expect(candidates[0]).toBe("C:/Users/nonah/Documents");
  });

  it("書庫の場所が作品の中なら飛ばす（作品の中に作品を置いている場合）", () => {
    const works = [
      { folderPath: "C:/Users/nonah/小説/親作品" },
      { folderPath: "C:/Users/nonah/小説/親作品/設定/子作品" },
    ];
    const candidates = existingWorkFolderHomeCandidates({ works });
    expect(
      candidates.some((c) => isSameLocation(c, "C:/Users/nonah/小説/親作品/設定"))
    ).toBe(false);
    expect(isSameLocation(candidates[0], "C:/Users/nonah/小説")).toBe(true);
  });

  it("ドライブの直下は既定にしない", () => {
    expect(
      existingWorkFolderHomeCandidates({ works: [{ folderPath: "C:/作品" }] })
    ).toEqual([]);
  });

  it("手がかりが無ければ、既定を出さない", () => {
    expect(existingWorkFolderHomeCandidates({ works: [] })).toEqual([]);
  });
});
