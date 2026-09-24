import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { mergeProposals } from "../../../src/core/proposalBuckets";

/**
 * 章立てをもう一度AIに提案させたとき、**前回と違う名前の案が消えずに並ぶ**
 * （設計書6.66.4。実機確認リスト F-66 の代わり）。
 *
 * 「別の案を見たい」がこの操作の主な使い道なので、2回目の結果で1回目の
 * 案が黙って消えると、見比べられない。消えないかどうかは2つで決まる。
 *
 * 1. 提案の印（id）に**名前まで入っている**こと（`features/proposeChapters.ts`）。
 *    開始の話数だけを印にすると、同じ話から始まる別名の案が「同じもの」とされ
 *    新しい方で置き換わる
 * 2. 提案パネルが、設定資料の更新の置き場を**印で突き合わせて足す**こと
 *    （`core/proposalBuckets.ts` の `mergeProposals`）
 *
 * 1 はソースの形で、2 は実際に足して確かめる（またがるので cross に置く）。
 */

/** 提案パネルの「設定資料の更新」に並ぶ1件と同じ形 */
function chapterItem(startEpisode: number, name: string, status = "pending") {
  return {
    // 製品と同じ組み立て（下の試験でソースと突き合わせる）
    id: `ch:${startEpisode}:${name}`,
    name,
    changes: [`第${startEpisode}話から`],
    source: `${String(startEpisode).padStart(3, "0")}.txt`,
    status,
  };
}

describe("章立ての提案を出し直す", () => {
  test("提案の印は、開始の話数と名前の両方で作る", () => {
    const source = readFileSync("src/features/proposeChapters.ts", "utf8");
    expect(source).toContain(
      "const id = `ch:${candidate.startEpisode}:${candidate.name}`;"
    );
  });

  test("提案パネルは、設定資料の更新の置き場へ足して並べる（入れ替えない）", () => {
    const panel = readFileSync("src/features/proposalPanel.ts", "utf8");
    expect(panel).toContain("bucket.recordUpdates = mergeProposals(");
  });

  test("同じ話から始まる別の名前の案は、前回の案と並んで残る", () => {
    const first = [chapterItem(3, "第一章　出立"), chapterItem(10, "第二章　都")];
    const second = [chapterItem(3, "第一章　旅立ち"), chapterItem(10, "第二章　王都")];

    const merged = mergeProposals(first, second);

    expect(merged.map((item) => item.name)).toEqual([
      "第一章　出立",
      "第二章　都",
      "第一章　旅立ち",
      "第二章　王都",
    ]);
  });

  test("同じ案がもう一度出たときは、1つに畳む（二重に並べない）", () => {
    const first = [chapterItem(3, "第一章　出立")];
    const second = [chapterItem(3, "第一章　出立"), chapterItem(3, "第一章　旅立ち")];

    const merged = mergeProposals(first, second);

    expect(merged.map((item) => item.name)).toEqual([
      "第一章　出立",
      "第一章　旅立ち",
    ]);
  });

  test("前回に承認した案は、出し直しても承認済みのまま", () => {
    const first = [chapterItem(3, "第一章　出立", "applied")];
    const second = [chapterItem(3, "第一章　出立"), chapterItem(3, "第一章　旅立ち")];

    const merged = mergeProposals(first, second);

    expect(merged.find((item) => item.name === "第一章　出立")?.status).toBe(
      "applied"
    );
    expect(merged.find((item) => item.name === "第一章　旅立ち")?.status).toBe(
      "pending"
    );
  });
});
