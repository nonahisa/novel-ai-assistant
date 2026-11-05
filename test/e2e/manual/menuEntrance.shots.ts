/**
 * 「入口」の画面ショットを1枚撮る（Discord の使い方の答えに添える。製品：Discord からの頼み 2026-11-05）。
 *
 * 左の端の「統合小説執筆環境」のアイコンと、詳細メニュー →「作品管理」→「既存原稿登録」を開いた所を
 * 赤い楕円で囲む。作者モード（自分の作品を書く人の画面）で撮る。
 *
 * 見本の作品は手順書の撮影と同じ作り話（「春を待つ灯（見本）」）。作者の原稿・確認用コピーは使わない。
 * **AI・GitHub は呼ばない。** 製品のコードは変えない。
 *
 * 出力：`media/promo/menu-entrance.png`（1280×720）。
 * 走らせ方：`npm run build` のあと
 * `npx vitest run --config vitest.manual.config.mts test/e2e/manual/menuEntrance.shots.ts`
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "playwright-core";
import { test } from "vitest";
import { SIDEBAR_LAUNCH, treeRowLabels } from "../support/sidebar";
import { withVsCode, type FixtureEpisode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dismissWorkbenchHover, pressWorkbenchKey } from "../support/workbenchDom";
import { clearRings, drawRings } from "./support/redRing";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = path.join(repositoryRoot, "media", "promo", "menu-entrance.png");

const SIZE = { width: 1280, height: 720 };
const WORK_TITLE = "春を待つ灯（見本）";
const ACTION_PANE = "詳細メニュー";

const EPISODES: FixtureEpisode[] = [
  { name: "001_灯をともす.txt", text: ["　春を待つ町に、小さな灯がともった。", "　「足もとに気をつけてください」と、娘は言った。", ""].join("\n") },
  { name: "002_雪どけ.txt", text: ["　雪どけの道を、二人は並んで歩いた。", ""].join("\n") },
];

const SETTINGS: Record<string, unknown> = {
  ...SIDEBAR_LAUNCH.settings,
  "novelai.mode": "author",
  "workbench.colorTheme": "Default Light Modern",
  "workbench.tree.enableStickyScroll": false,
  "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false,
  "window.commandCenter": false,
  "window.zoomLevel": 0,
};

test("入口の画面ショット（左端のアイコンと、詳細メニューの作品管理）を撮る", async () => {
  await mkdir(path.dirname(OUT), { recursive: true });
  await withVsCode(
    "入口の画面ショット",
    EPISODES,
    async (session) => {
      const { page } = session;
      await clearNotifications(page);
      await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
      for (const title of ["AIに相談", "簡単ステップメニュー", "作品一覧"]) await setPaneExpanded(page, title, false).catch(() => undefined);
      await setPaneExpanded(page, ACTION_PANE, true);
      await expandRow(page, ACTION_PANE, "作品管理");
      await expandRow(page, ACTION_PANE, "既存原稿登録");
      await clearNotifications(page);
      await dismissWorkbenchHover(page).catch(() => undefined);
      await page.mouse.move(SIZE.width - 10, SIZE.height - 40);
      await page.waitForTimeout(600);
      await drawRings(page, [
        { locator: page.locator('.part.activitybar .action-item .action-label[aria-label*="統合小説執筆環境"]').first(), label: "左の「統合小説執筆環境」のアイコン" },
        { locator: paneRow(page, ACTION_PANE, "既存原稿登録").locator(".label-name").first(), label: "「既存原稿登録」" },
      ]);
      await page.waitForTimeout(150);
      await page.screenshot({ path: OUT });
      await clearRings(page);
      process.stdout.write(`[入口] 撮った：${OUT}\n`);
    },
    { settings: SETTINGS, keybindings: SIDEBAR_LAUNCH.keybindings, windowSize: SIZE, workTitle: WORK_TITLE }
  );
}, 300_000);

function pane(page: Page, title: string): Locator {
  return page.locator(".pane", { has: page.locator(".pane-header", { hasText: title }) }).first();
}

function paneRow(page: Page, title: string, head: string): Locator {
  return pane(page, title).locator(`.monaco-list-row[aria-label^="${head}"]`).first();
}

async function setPaneExpanded(page: Page, title: string, expanded: boolean): Promise<void> {
  const header = page.locator(".pane-header", { hasText: title }).first();
  await header.waitFor({ state: "visible", timeout: 15_000 });
  const isOpen = async () => (await header.getAttribute("aria-expanded")) === "true";
  if ((await isOpen()) === expanded) return;
  await header.click({ position: { x: 12, y: 10 } });
  await waitUntil(async () => (await isOpen()) === expanded, `左の列の「${title}」を${expanded ? "開く" : "畳む"}`, 5_000);
  await page.waitForTimeout(300);
}

async function expandRow(page: Page, title: string, head: string): Promise<void> {
  const row = paneRow(page, title, head);
  await waitUntil(async () => (await row.count()) > 0, `「${title}」に「${head}」の行が出る`, 15_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
  });
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await row.locator(".label-name").first().click();
  await waitUntil(async () => (await row.getAttribute("aria-expanded")) === "true", `「${head}」が開く`, 5_000);
  await page.waitForTimeout(300);
}
