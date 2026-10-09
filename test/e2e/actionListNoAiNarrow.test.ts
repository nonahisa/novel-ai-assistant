/**
 * 詳細メニューを狭いサイドバー（約240px）にしても、AIを呼ばない操作の右の薄字が切れない
 * （画面の自動テスト、設計書6.17.8・6.113。実機確認リスト 608 の写真、2026-10-09）。
 *
 * 写真：左の列を240pxに絞ると、名前の右に出る「AIを使わない」が「AIを…」「AIを使わ…」と
 * 切れていた（名前そのものは9字以内に収めてあり、切れていない）。
 *
 * 確かめること：AIを呼ばない操作の薄字（`NO_AI_DESCRIPTION`）が並ぶ行を全部開き、
 * どの行でも薄字が行の右端で省略されていない。
 */
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import {
  ACTION_TREE,
  isItemShownInActionList,
  NO_AI_DESCRIPTION,
  type ActionItem,
  type ActionSection,
} from "../../src/core/actionTree";
import { openEpisode } from "./support/manuscriptFrame";
import { showSidebar, SIDEBAR_LAUNCH } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { setPane, setRow, setSidebarWidth } from "./look/lookSupport";

const EPISODE = "001_はじまり.txt";

function marked(item: ActionItem): boolean {
  return item.description === NO_AI_DESCRIPTION && isItemShownInActionList(item, true);
}

/** 薄字の付いた操作が並ぶ束と、その中の小分類（開く順） */
function placesToOpen(): Array<{ group: string; sections: string[] }> {
  const places: Array<{ group: string; sections: string[] }> = [];
  for (const group of ACTION_TREE) {
    const sections: string[] = [];
    let direct = false;
    for (const entry of group.entries) {
      if (entry.kind === "section") {
        if ((entry as ActionSection).items.some(marked)) sections.push(entry.label);
      } else if (marked(entry)) {
        direct = true;
      }
    }
    if (direct || sections.length > 0) places.push({ group: group.label, sections });
  }
  return places;
}

/** いま見えている行のうち、薄字が切れている行（名前と、見えている幅・要る幅） */
async function clippedDescriptions(page: Page, description: string): Promise<string[]> {
  return page.evaluate((description) => {
    const found: string[] = [];
    document.querySelectorAll(".monaco-list-row").forEach((row) => {
      const desc = row.querySelector(".label-description") as HTMLElement | null;
      if (!desc || (desc.textContent ?? "").trim() !== description) return;
      const container = row.querySelector(".monaco-icon-label-container") as HTMLElement | null;
      if (!container) return;
      const descBox = desc.getBoundingClientRect();
      const boxRight = container.getBoundingClientRect().right;
      // 薄字の右端が、省略の箱（右端で「…」にする枠）の外へ出ていれば切れている
      if (descBox.right > boxRight + 0.5 || container.scrollWidth > container.clientWidth + 0.5) {
        found.push(
          `${row.getAttribute("aria-label") ?? ""}（薄字の右端 ${Math.round(descBox.right)}px・枠の右端 ${Math.round(boxRight)}px）`
        );
      }
    });
    return found;
  }, description);
}

test("狭いサイドバーでも、AIを呼ばない操作の右の薄字は切れない", async () => {
  await withVsCode(
    "詳細メニュー・狭い幅の薄字",
    [{ name: EPISODE, text: "一行目の文。\n" }],
    async (session) => {
      const { page } = session;
      await openEpisode(page, EPISODE, "一行目の文");
      await showSidebar(page, E2E_WORK_TITLE);
      await setPane(page, "作品一覧", false);
      await setPane(page, "簡単ステップメニュー", false);
      const width = await setSidebarWidth(page, 240);
      expect(width, "左の列が狭くなっていません").toBeLessThanOrEqual(260);

      const clipped: string[] = [];
      let seen = 0;
      for (const place of placesToOpen()) {
        await setRow(page, place.group, true);
        for (const section of place.sections) {
          await setRow(page, section, true);
          await page.waitForTimeout(200);
          seen += await page.evaluate(
            (description) =>
              Array.from(document.querySelectorAll(".monaco-list-row .label-description")).filter(
                (node) => (node.textContent ?? "").trim() === description
              ).length,
            NO_AI_DESCRIPTION
          );
          clipped.push(...(await clippedDescriptions(page, NO_AI_DESCRIPTION)));
          await setRow(page, section, false);
        }
        clipped.push(...(await clippedDescriptions(page, NO_AI_DESCRIPTION)));
        await setRow(page, place.group, false);
      }
      expect(seen, "薄字の付いた行が1つも開けていません").toBeGreaterThan(0);
      expect([...new Set(clipped)], `左の列 ${width}px で薄字が切れています`).toEqual([]);
    },
    { ...SIDEBAR_LAUNCH, windowSize: { width: 1280, height: 800 } }
  );
});
