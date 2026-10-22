/**
 * Discord「機能紹介」用の広報素材：EPUBエディター（作者の依頼 2026-10-22）。
 * features.md の文：表紙・目次・挿絵・奥付・人物紹介を、プレビューで確かめながら組める。
 * 「電子出版等 → EPUBエディター」から使える。
 *
 * **AIは呼ばない。** 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/epubEditorScene.promo.ts`
 */
import { test } from "vitest";
import type { Frame, Page } from "playwright-core";
import { runCommand } from "../support/quickInput";
import { waitUntil } from "../support/wait";
import { pickQuickPickRow, quickPickTitle } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";
import { hideTitleCard, showTitleCard } from "./support/overlay";

const EPISODES = [
  { name: "第1話_雨の駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n　ホームの時計が、零時を指していた。\n" },
  { name: "第2話_朝の窓口.txt", text: "　翌朝の窓口で、駅員は切符を差し出した。\n　傘は、まだ濡れていた。\n" },
  { name: "第3話_始発.txt", text: "　始発の汽笛が、駅の屋根を揺らした。\n" },
];

/** EPUBエディター（目印は「本の設定」の行 `#railBook` と並びの箱 `#blockList`） */
async function epubFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("railBook") !== null && document.getElementById("blockList") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

async function railLabels(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll("#blockList .rail-row")).map((row) => (row.querySelector(".rail-label")?.textContent ?? "").trim())
  );
}

test("EPUBエディターの広報素材を撮る", async () => {
  await recordFeature({
    name: "epub-editor",
    subtitle: "EPUBエディター — 表紙・目次・奥付をプレビューで確かめながら組む",
    workTitle: "雨の駅",
    settings: { "window.zoomLevel": -1 },
    episodes: EPISODES,
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    snapAt: 7.5,
    play: async ({ page }, caption) => {
      await caption("「EPUBエディター」を開く");
      await page.waitForTimeout(800);
      // 開いた直後の面に書き込み先の絶対パスが一瞬出るので、隠し終えるまで幕を下ろしておく
      await showTitleCard(page, "統合小説執筆環境", "EPUBエディター");
      await runCommand(page, "EPUBエディター（試作）");
      await page.waitForTimeout(500);
      if ((await quickPickTitle(page)) !== undefined) await pickQuickPickRow(page, "雨の駅");
      let found: Frame | undefined;
      await waitUntil(
        async () => {
          found = await epubFrame(page);
          return found !== undefined && (await railLabels(found)).length > 0;
        },
        "EPUBエディターが開く",
        30_000
      );
      const epub = found as Frame;
      // 画面の下に、書き込み先の絶対パス（利用者名を含む）が出る。出た瞬間から隠し続ける
      await epub.evaluate(() => {
        const hide = (): void => {
          for (const node of Array.from(document.querySelectorAll("body *"))) {
            if (node.children.length === 0 && /^[A-Za-z]:[\\/]/.test((node.textContent ?? "").trim())) (node as HTMLElement).style.visibility = "hidden";
          }
        };
        hide();
        new MutationObserver(hide).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      await hideTitleCard(page);
      const labels = await railLabels(epub);
      process.stdout.write(`[広報] EPUB 並び：${JSON.stringify(labels)}\n`);
      await page.waitForTimeout(2_000);
      await caption("表紙・目次・奥付を、プレビューで確かめながら組む");
      for (const wanted of ["表紙", "目次", "奥付"]) {
        const row = epub.locator("#blockList .rail-row", { has: epub.locator(".rail-label", { hasText: wanted }) }).first();
        if ((await row.count()) === 0) continue;
        await row.click();
        // 画面の下に、書き込み先の絶対パス（利用者名を含む）が出るので、撮る前に隠す
        await epub
          .evaluate(() => {
            for (const node of Array.from(document.querySelectorAll("body *"))) {
              if (node.children.length === 0 && /^[A-Za-z]:[\\/]/.test((node.textContent ?? "").trim())) (node as HTMLElement).style.visibility = "hidden";
            }
          })
          .catch(() => undefined);        await epub.locator("#pages").scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout(2_200);
      }
    },
  });
});
