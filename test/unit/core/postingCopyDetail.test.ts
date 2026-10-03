import { describe, expect, test } from "vitest";
import { ACTION_TREE, type ActionItem, type ActionSection } from "../../../src/core/actionTree";
import { POSTING_SITES } from "../../../src/models/posting";

/**
 * 「投稿用変換・コピー」の説明文が、いまの手順と食い違わない
 * （実機確認リスト D-1「投稿サイト用に変換してコピー」の2段）。
 *
 * 2段（記法→傍点があるときだけサイト）は 2026-09-06 の作者の裁定で
 * 「貼り付け先を1度だけ訊く」に変わった（`core/postingCopyTargets.ts`）。
 * ところがツールチップには「傍点が入っているときだけ貼り付け先を訊く」が
 * 残り、貼れる先にも note が無かった。説明を読んだ作者は、訊かれない
 * はずの画面が出たと受け取る。
 */
function findItem(command: string): ActionItem | undefined {
  const visit = (entry: ActionItem | ActionSection): ActionItem | undefined => {
    if (entry.kind === "action") return entry.command === command ? entry : undefined;
    for (const child of entry.items) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const group of ACTION_TREE) {
    for (const entry of group.entries) {
      const hit = visit(entry);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe("投稿用変換・コピーの説明", () => {
  const item = findItem("novelai.copyForPosting");

  test("傍点の有無で訊き方が変わる、という古い説明が残っていない", () => {
    expect(item).toBeDefined();
    expect(item?.detail).not.toContain("傍点が入っているときだけ");
    expect(item?.detail).toContain("貼り付け先");
  });

  test("貼れるサイトの名前が、投稿先の一覧と揃っている", () => {
    for (const site of POSTING_SITES) {
      expect(item?.detail, site.label).toContain(shortName(site.label));
    }
  });
});

/** 説明文では「小説家になろう」を「なろう」と縮めて書く */
function shortName(label: string): string {
  return label === "小説家になろう" ? "なろう" : label;
}
