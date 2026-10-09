/**
 * 実機確認リストの 〔作者の手：見〕 のうち、書き出しの紙・HTML の見た目を写真に撮る
 * （2026-10-09。作者が見た目の良し悪しを判断するための写真。判断そのものはしない）。
 *
 * **VS Code は起こさない。** 製品が書き出す HTML は、組み立てる関数（`buildPrintHtml`・
 * `buildGridPrintHtml`・`buildExportHtml`）が返す1枚の文字列そのもの。それを
 * 作者の画面の外で、Edge（なければ playwright の Chromium）で開いて撮る。
 * 本物のコマンドは書き出したあとに作者の既定のブラウザを開いてしまうので使わない。
 * PDF は同じページをブラウザの印刷（`page.pdf`）に通したもの（ページ数を数えるのにも使う）。
 *
 * `NOVELAI_LOOK=1` のときだけ動く（通常の E2E には入らない）。
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildGridPrintHtml, type GridPaper } from "../../../src/core/printGridHtml";
import { buildPrintHtml, type PrintEpisode } from "../../../src/core/printHtml";
import { buildExportDocument } from "../../../src/core/settingsExportProfiles";
import { buildExportHtml } from "../../../src/core/settingsExportHtml";
import type { GridOptions } from "../../../src/core/manuscriptGrid";
import { FIXTURE_OPTIONS, fixtureData } from "../../unit/support/settingsExportFixture";
import { lookDir, lookEnabled } from "./lookSupport";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

let browser: Browser | undefined;

async function openHtml(html: string, viewport = { width: 1280, height: 900 }): Promise<Page> {
  if (!browser) throw new Error("ブラウザが起きていません");
  const dir = path.join(lookDir(), "_html");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `tmp-${Date.now()}.html`);
  await writeFile(file, html, "utf8");
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1.5 });
  await page.goto("file:///" + file.replace(/\\/g, "/"));
  // 面に割るスクリプトが走り終わるのを待つ（面が1枚以上並ぶ）
  await page.waitForFunction(() => document.querySelectorAll("#print-pages .page").length > 0 || !document.getElementById("print-pages"), null, { timeout: 30_000 });
  await page.waitForTimeout(800);
  return page;
}

async function savePage(page: Page, name: string, options: { fullPage?: boolean } = {}): Promise<void> {
  await mkdir(lookDir(), { recursive: true });
  await page.screenshot({ path: path.join(lookDir(), `${name}.png`), fullPage: options.fullPage ?? true });
}

/** `from`〜`to` 番目（0から）の面を含む範囲の写真 */
async function savePages(page: Page, name: string, from: number, to: number): Promise<void> {
  const box = await page.evaluate(
    ({ a, b }) => {
      const pages = Array.from(document.querySelectorAll("#print-pages .page")) as HTMLElement[];
      const first = pages[Math.min(a, pages.length - 1)]?.getBoundingClientRect();
      const last = pages[Math.min(b, pages.length - 1)]?.getBoundingClientRect();
      if (!first || !last) return undefined;
      const top = first.top + window.scrollY;
      const bottom = last.bottom + window.scrollY;
      return { x: 0, y: Math.max(0, top - 12), width: document.documentElement.scrollWidth, height: bottom - top + 24 };
    },
    { a: from, b: to }
  );
  if (!box) throw new Error(`面が足りません（${from}〜${to}）`);
  await mkdir(lookDir(), { recursive: true });
  await page.screenshot({ path: path.join(lookDir(), `${name}.png`), fullPage: true, clip: box });
}

/** 面（`.page`）の数と案内帯の文 */
async function pageFacts(page: Page): Promise<{ pages: number; band: string }> {
  return page.evaluate(() => ({
    pages: document.querySelectorAll("#print-pages .page").length,
    band: (document.querySelector(".print-guide, #print-guide, .guide")?.textContent ?? document.body.innerText.slice(0, 200)).replace(/\s+/g, " ").trim(),
  }));
}

/** その紙を、ブラウザの印刷で PDF にして、ページ数と一緒に残す */
async function savePdf(page: Page, name: string): Promise<number> {
  await mkdir(lookDir(), { recursive: true });
  const file = path.join(lookDir(), `${name}.pdf`);
  const buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await writeFile(file, buffer);
  // ページ数は PDF の `/Type /Page` の数（目安。1ページ目の木の親は `/Pages` で別）
  return (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

const SENTENCES = [
  "朝の駅は、まだ眠っているようだった。",
  "「{改札|かいさつ}の向こうで待っています」と彼女は言った。",
  "彼は黙って頷き、{{古い切符}}を握りしめた。",
  "3月5日の{夜明け前|よあけまえ}、{長い長い読み仮名のついた言葉|ながいながいよみがなのついたことば}だけが、雨の中に残っていた。",
  "ホームの時計が零時を指し、最終電車の灯りが遠ざかっていく。",
  "「どうして、ここまで来たんですか。」と問われても、答えられなかった。",
  "それでも、足は前へ出た。雨の音だけが、彼の背中を押していた。",
  "「行こう」と彼は小さく言った。彼女は、うなずいた。",
];

/** 長い段落を作る（句読点と閉じ括弧が面の切れ目に来やすいよう、字数をずらして並べる） */
function longBody(paragraphs: number): string {
  const lines: string[] = [];
  for (let p = 0; p < paragraphs; p++) {
    let text = "　";
    for (let i = 0; i < 6 + (p % 4); i++) text += SENTENCES[(p + i) % SENTENCES.length];
    lines.push(text);
  }
  return lines.join("\n");
}

const EPISODES: PrintEpisode[] = [
  { heading: "第1話　夜の駅", body: longBody(24), notation: "curly" },
  { heading: "第2話　朝の線路", body: longBody(18), notation: "curly" },
];

const GRID40: GridOptions = { columns: 40, rows: 40, hanging: true, vertical: true };

describe.skipIf(!lookEnabled)("見た目の写真：書き出し", () => {
  beforeAll(async () => {
    const executablePath = EDGE_PATHS.find((candidate) => existsSync(candidate));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("設定資料の書き出し（HTML・PDF）", async () => {
    const html = buildExportHtml(buildExportDocument("editorial", fixtureData(), { ...FIXTURE_OPTIONS, chapter: null }));
    const page = await openHtml(html);
    await savePage(page, "28-設定資料HTML-画面");
    await page.emulateMedia({ media: "print" });
    await savePage(page, "27-設定資料PDF-印刷表示");
    const pdfPages = await savePdf(page, "27-設定資料");
    await writeFile(path.join(lookDir(), "27-設定資料-ページ数.txt"), `ブラウザの印刷で ${pdfPages} ページ\n`, "utf8");
    expect(pdfPages).toBeGreaterThan(0);
    await page.close();
  });

  test("印刷用 PDF（文庫・縦書き）：扉・ページの切れ目・上下の余白", async () => {
    const plain = await openHtml(
      buildPrintHtml({ workTitle: "銀の航路", episodes: EPISODES, preset: "bunko-vertical" }),
      { width: 1500, height: 1000 }
    );
    const facts = await pageFacts(plain);
    await savePages(plain, "6432-扉と最初のページ-文庫縦", 0, 1);
    const fonts = await plain.evaluate(() => ({
      yuMincho: document.fonts.check('16px "Yu Mincho"'),
      mincho: document.fonts.check('16px "MS Mincho"'),
      hiragino: document.fonts.check('16px "Hiragino Mincho ProN"'),
      coverFont: getComputedStyle(document.querySelector(".cover-title") ?? document.body).fontFamily,
    }));
    await writeFile(path.join(lookDir(), "6432-この機械の明朝.txt"), JSON.stringify({ ...facts, fonts }, null, 2), "utf8");
    // 面の切れ目（次の面の頭が「。」「」」で始まっていないか見る）
    await savePages(plain, "6446-ページの切れ目-文庫縦-2から4枚目", 1, 3);
    await savePdf(plain, "6446-文庫縦-ページの切れ目");
    await plain.close();

    const margins = await openHtml(
      buildPrintHtml({
        workTitle: "銀の航路",
        episodes: EPISODES,
        preset: "bunko-vertical",
        headerFooter: { top: "title", bottom: "author" },
        author: "野中ひさ",
      }),
      { width: 1500, height: 1000 }
    );
    await savePages(margins, "6453-上に題名下に作者名-文庫縦", 1, 2);
    await savePages(margins, "6454-上下の文字の大きさと位置-文庫縦", 1, 1);
    await margins.close();
  });

  test("公募の納品用（40字×40行・縦書き）：升目・禁則・ルビ・縦中横・字の大きさ・台本", async () => {
    async function grid(paper: GridPaper, body: string, options: GridOptions = GRID40): Promise<Page> {
      return openHtml(
        buildGridPrintHtml({
          workTitle: "銀の航路",
          episodes: [{ heading: "第1話　夜の駅", body, notation: "curly" }],
          paper,
          grid: options,
        }),
        { width: 1700, height: 1100 }
      );
    }
    const body = longBody(40);

    const landscape = await grid("a4-landscape", body);
    const facts = await pageFacts(landscape);
    await writeFile(path.join(lookDir(), "6458-面の数と案内帯.txt"), JSON.stringify(facts, null, 2), "utf8");
    await savePages(landscape, "6458-升目の面-A4横置き-扉と1から2枚目", 0, 2);
    await savePages(landscape, "6459-行頭行末とぶら下げ-A4横置き-1枚目", 1, 1);
    await savePages(landscape, "6460-ルビ傍点縦中横-A4横置き-1枚目", 1, 1);
    await savePages(landscape, "6461-字の大きさ-40x40-A4横置き", 1, 1);
    const pdfPages = await savePdf(landscape, "6458-公募40x40-A4横置き");
    await writeFile(path.join(lookDir(), "6458-ブラウザの印刷ページ数.txt"), `PDF ${pdfPages} ページ／画面の面 ${facts.pages} 枚（扉を含む）\n`, "utf8");
    await landscape.close();

    const portrait = await grid("a4-portrait", body);
    await savePages(portrait, "6461-字の大きさ-40x40-A4縦置き", 1, 1);
    await portrait.close();

    const script = await grid(
      "a4-landscape",
      ["○駅前・夜", "", "　太郎、ドアを開ける。", "太郎「行こう」", "花子「待って。」", "　二人、雨の中へ。"].join("\n")
    );
    await savePages(script, "6463-台本の升目-A4横置き", 1, 1);
    await script.close();
  });
});
