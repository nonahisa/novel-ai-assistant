/**
 * Discord「機能紹介」用の広報素材：文字数と原稿用紙換算（作者の依頼 2026-10-22）。
 * features.md の文：作品一覧にファイルごと・作品ごとの文字数、ステータスバーに開いているファイル
 * （と選択範囲）の文字数、ツールチップに総文字数・段落数・原稿用紙換算。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/charCountScene.promo.ts`
 */
import { test } from "vitest";
import { expandTreeRow, showSidebar, SHOW_SIDEBAR_KEY } from "../support/sidebar";
import { waitUntil } from "../support/wait";
import { quickOpen, statusBarTexts } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

const LINE = "　終電を逃した駅のホームに、雨の音だけが残っていた。傘を持たない彼女は、時計の針ばかりを見つめている。\n";
const BODY1 = LINE.repeat(3) + "\n" + LINE.repeat(4);
const BODY2 = LINE.repeat(2) + "\n" + LINE.repeat(3) + "\n" + LINE;

test("文字数と原稿用紙換算の広報素材を撮る", async () => {
  await recordFeature({
    name: "char-count",
    subtitle: "文字数と原稿用紙換算",
    workTitle: "雨の駅",
    episodes: [
      { name: "001_雨の駅.txt", text: BODY1 },
      { name: "002_最後の電車.txt", text: BODY2 },
    ],
    closeSidebar: false,
    settings: {
      "workbench.statusBar.visible": true,
      "window.menuStyle": "custom",
      "workbench.hover.delay": 300,
    },
    keybindings: [{ key: SHOW_SIDEBAR_KEY, command: "workbench.view.extension.novelai" }, { key: "ctrl+alt+shift+f8", command: "workbench.action.reopenTextEditor" }],
    snapAt: 16,
    open: async ({ page }) => {
      await showSidebar(page, "雨の駅");
      await expandTreeRow(page, "雨の駅");
      await page.waitForTimeout(1_000);
    },
    play: async ({ page }, caption) => {
      await caption("作品一覧に、ファイルごと・作品ごとの文字数が出る");
      await page.waitForTimeout(4_500);
      await quickOpen(page, "001_雨の駅.txt");
      await page.keyboard.press("Control+Alt+Shift+F8");
      await waitUntil(async () => (await statusBarTexts(page)).some((text) => text.includes("字")), "文字数がステータスバーに出る", 20_000);
      await caption("開いているファイルの文字数は、ステータスバーに出る");
      await page.waitForTimeout(2_500);
      await page.keyboard.press("Control+KeyA");
      await caption("選択した範囲の文字数も出る");
      await page.waitForTimeout(2_500);
      const item = page.locator(".part.statusbar .statusbar-item", { hasText: "字" }).first();
      await item.hover();
      await caption("合わせると、総文字数・段落数・原稿用紙換算が出る");
      await page.waitForTimeout(5_000);
    },
  });
});
