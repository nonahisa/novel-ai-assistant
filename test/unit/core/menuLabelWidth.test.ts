import { describe, expect, test } from "vitest";
import {
  ACTION_TREE,
  isItemShownInActionList,
  type ActionItem,
  type ActionSection,
} from "../../../src/core/actionTree";

/**
 * 詳細メニューに見えている名前は、全角9字ぶんに収める（作者の裁定
 * 「長い名前を短くする」、2026-10-03。設計書6.17.8）。
 *
 * サイドバーの既定の幅（約240px）では、「統合小説執筆環境設定」が
 * 「統合小説執筆…」に、「AIチューニング実測一覧」が途中で切れていた。
 *
 * **半角は全角の半分と数える**（「AI」で全角1字ぶん）。見るのは画面に
 * 出るものだけ——詳細メニューから外した操作（`hiddenFromActionList`）は
 * サイドバーに並ばないので数えない。
 *
 * 9字で切れないとは限らない。右に出る薄字（「AIを使わない」、押せない理由）
 * も同じ行の幅を使う。ここが見張るのは名前の側だけである。
 */
const MAX_WIDTH = 9;

function width(label: string): number {
  return [...label].reduce(
    (total, char) => total + ((char.codePointAt(0) ?? 0) < 0x2000 ? 0.5 : 1),
    0
  );
}

function shownLabels(): string[] {
  const labels: string[] = [];
  const visit = (entry: ActionItem | ActionSection) => {
    if (entry.kind === "section") {
      labels.push(entry.label);
      entry.items.filter(isItemShownInActionList).forEach(visit);
      return;
    }
    if (isItemShownInActionList(entry)) labels.push(entry.label);
  };
  for (const group of ACTION_TREE) {
    labels.push(group.label);
    group.entries.forEach(visit);
  }
  return labels;
}

describe("狭いサイドバーで切れない名前", () => {
  test("見えている束・小分類・操作の名前は全角9字ぶん以内", () => {
    const tooWide = shownLabels()
      .filter((label) => width(label) > MAX_WIDTH)
      .map((label) => `${label}（${width(label)}字ぶん）`);
    expect(tooWide, "意味の通じる範囲で短くし、外した語は note へ").toEqual([]);
  });

  test("数え方：半角は全角の半分", () => {
    expect(width("AI設定")).toBe(3);
    expect(width("環境設定")).toBe(4);
  });
});
