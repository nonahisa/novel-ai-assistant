import { describe, expect, test } from "vitest";
import { dropNeighbors, sceneLabel, snippet } from "../../../src/features/sceneSearch";
import { manuscriptItems } from "../../../src/core/retrievalCorpus";
import type { RetrievalCandidate } from "../../../src/core/retrieval";

/**
 * 場面検索の一覧の作り（設計書6.19.10）。
 *
 * 検索そのものは相談と同じ部品（`retrieval.test.ts` が見ている）。ここでは
 * **作者に並べるときの形**だけを見る。
 */

function longEpisode(lines: number): string {
  return Array.from({ length: lines }, (_, at) => `${at}行目の本文がここに続いている。`).join("\n");
}

describe("一覧の見出し", () => {
  test("話の名前と、話の中の何番目の場面かを出す", () => {
    const [first] = manuscriptItems("第12話 再会", longEpisode(60));
    expect(sceneLabel(first)).toMatch(/^第12話 再会（場面 1\/\d+）$/);
  });

  test("1つに収まった話は、場面の番号を出さない", () => {
    const [only] = manuscriptItems("第1話", "灯は目を覚ました。");
    expect(sceneLabel(only)).toBe("第1話");
  });

  test("2行目は改行を詰めて頭だけ", () => {
    expect(snippet("一行目\n\n二行目", 5)).toBe("一行目 二…");
  });
});

describe("隣り合う場面は1つにまとめる", () => {
  const items = manuscriptItems("第3話", longEpisode(200));
  const candidate = (at: number): RetrievalCandidate => ({
    item: items[at],
    foundBy: "意味検索",
  });

  test("重ねて切った隣の場面は、先に並んだほうだけを残す", () => {
    const kept = dropNeighbors([candidate(2), candidate(3), candidate(6)]);
    expect(kept.map((entry) => entry.item.part?.index)).toEqual([3, 7]);
  });

  test("別の話なら、場面の番号が近くても残す", () => {
    const other = manuscriptItems("第4話", longEpisode(200));
    const kept = dropNeighbors([
      candidate(2),
      { item: other[2], foundBy: "語句一致" },
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe("本文の場面は、元のファイルと話数を持つ", () => {
  test("押したときに開くファイル・前の話だけに絞る話数", () => {
    const [item] = manuscriptItems("第5話", "本文", {
      filePath: "C:/作品/本文/005.txt",
      chapter: 5,
    });
    expect(item.filePath).toBe("C:/作品/本文/005.txt");
    expect(item.chapter).toBe(5);
  });

  test("ハッシュ（索引の鍵）は、ファイルと話数で変わらない", () => {
    // 変わると、索引を作り直さないと1件も当たらなくなる
    const [plain] = manuscriptItems("第5話", "本文");
    const [withOrigin] = manuscriptItems("第5話", "本文", {
      filePath: "C:/作品/本文/005.txt",
      chapter: 5,
    });
    expect(withOrigin.hash).toBe(plain.hash);
    expect(withOrigin.id).toBe(plain.id);
  });
});
