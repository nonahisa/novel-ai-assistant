/**
 * 「入口」の画面ショットを2枚撮る（Discord の使い方の答えに添える。製品：Discord からの頼み 2026-11-05）。
 *
 * 左の端の「統合小説執筆環境」のアイコンと、メニューの見出しを赤い楕円で囲む。作者モード
 * （自分の作品を書く人の画面）で、簡単ステップメニューと詳細メニューの両方を開いて撮る。
 *
 * **メニューごとに1枚**（2026-11-06）。最初は詳細メニューの「既存原稿登録」だけに印があったが、
 * 作者モードの使い方の答えは多くが簡単ステップメニューから案内し、詳細メニューから案内するものも残る。
 * 囲みは1枚に2つまで（`redRing.ts` の作者の決まり）なので、作者の選択「2枚に分ける」に従う。
 * ボットは答えが案内するメニューに合わせて片方を添える。
 *
 * 見本の作品は手順書の撮影と同じ作り話（「春を待つ灯（見本）」）。作者の原稿・確認用コピーは使わない。
 * **AI・GitHub は呼ばない。** 製品のコードは変えない。
 *
 * 出力（どちらも1280×720）：`media/promo/menu-entrance.png`（簡単ステップメニュー。名前は前のまま）と
 * `media/promo/menu-entrance-detail.png`（詳細メニュー）。
 * 走らせ方：`npm run build` のあと
 * `npx vitest run --config vitest.manual.config.mts test/e2e/manual/menuEntrance.shots.ts`
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import { test } from "vitest";
import { SIDEBAR_LAUNCH } from "../support/sidebar";
import { withVsCode, type FixtureEpisode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dismissWorkbenchHover, pressWorkbenchKey } from "../support/workbenchDom";
import { clearRings, drawRings } from "./support/redRing";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHOTS = [
  { pane: "簡単ステップメニュー", out: path.join(repositoryRoot, "media", "promo", "menu-entrance.png") },
  { pane: "詳細メニュー", out: path.join(repositoryRoot, "media", "promo", "menu-entrance-detail.png") },
] as const;

const SIZE = { width: 1280, height: 720 };
const WORK_TITLE = "春を待つ灯（見本）";
const ACTION_PANE = "詳細メニュー";
const STEP_PANE = "簡単ステップメニュー";

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
  await mkdir(path.dirname(SHOTS[0].out), { recursive: true });
  await withVsCode(
    "入口の画面ショット",
    EPISODES,
    async (session) => {
      const { page } = session;
      await clearNotifications(page);
      await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
      for (const title of ["AIに相談", "作品一覧"]) await setPaneExpanded(page, title, false).catch(() => undefined);
      await setPaneExpanded(page, STEP_PANE, true);
      await setPaneExpanded(page, ACTION_PANE, true);
      await clearNotifications(page);
      await dismissWorkbenchHover(page).catch(() => undefined);
      await page.mouse.move(SIZE.width - 10, SIZE.height - 40);
      await page.waitForTimeout(600);
      const icon = {
        locator: page.locator('.part.activitybar .action-item .action-label[aria-label*="統合小説執筆環境"]').first(),
        label: "左の「統合小説執筆環境」のアイコン",
      };
      for (const shot of SHOTS) {
        // 簡単ステップメニューの1枚は、詳細メニューを畳んで欄を高くする（2026-11-06 作者の裁定「撮り直す」）。
        // 2つとも開くと欄が半分ずつに分かれ、「5. 投稿脱稿」が下で切れていた。詳細メニューの1枚は両方を開いたまま
        await setPaneExpanded(page, ACTION_PANE, shot.pane !== STEP_PANE);
        await dismissWorkbenchHover(page).catch(() => undefined);
        await page.mouse.move(SIZE.width - 10, SIZE.height - 40);
        await page.waitForTimeout(400);
        await drawRings(page, [
          icon,
          { locator: page.locator(".pane-header", { hasText: shot.pane }).first().locator(".title").first(), label: `「${shot.pane}」の見出し` },
        ]);
        await page.waitForTimeout(150);
        await page.screenshot({ path: shot.out });
        await clearRings(page);
        process.stdout.write(`[入口] 撮った：${shot.out}\n`);
      }
    },
    { settings: SETTINGS, keybindings: SIDEBAR_LAUNCH.keybindings, windowSize: SIZE, workTitle: WORK_TITLE }
  );
}, 300_000);

async function setPaneExpanded(page: Page, title: string, expanded: boolean): Promise<void> {
  const header = page.locator(".pane-header", { hasText: title }).first();
  await header.waitFor({ state: "visible", timeout: 15_000 });
  const isOpen = async () => (await header.getAttribute("aria-expanded")) === "true";
  if ((await isOpen()) === expanded) return;
  await header.click({ position: { x: 12, y: 10 } });
  await waitUntil(async () => (await isOpen()) === expanded, `左の列の「${title}」を${expanded ? "開く" : "畳む"}`, 5_000);
  await page.waitForTimeout(300);
}
