/**
 * 漫画の原作の紙を写真に撮る（作者の裁定、2026-10-17「漫画の原作にも、台本と同じ組み方を当てる」）。
 * `printLookWork.test.ts` の台本の写真と同じ撮り方で、例文は作り物（作者の作品は読まない）。
 *
 * **VS Code は起こさない。** 紙は製品の組み立て関数（`buildPrintHtml`・`buildGridPrintHtml`）が
 * 返す1枚の HTML。開くのは Edge（なければ playwright の Chromium）で、作者の画面の外。
 * `NOVELAI_LOOK=1` のときだけ動く。写真の置き場は `NOVELAI_LOOK_DIR`（`lookSupport.ts`）。
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { GridOptions } from "../../../src/core/manuscriptGrid";
import { buildGridPrintHtml } from "../../../src/core/printGridHtml";
import { buildPrintHtml } from "../../../src/core/printHtml";
import { lookDir, lookEnabled } from "./lookSupport";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const GRID40: GridOptions = { columns: 40, rows: 40, hanging: true, vertical: true };

/**
 * 作り物の漫画の原作。ページ（■）・コマ（□）・絵の説明（全角空白の字下げ）・台詞が並ぶ。
 * 欄（5字）より長い人物名、2行以上に折り返す台詞、「「」を含むコマの行（台詞にしない）を入れる
 */
const MANGA_BODY = [
  "■1ページ",
  "",
  "□コマ1（大ゴマ）",
  "　放課後の教室。窓の外は夕焼けで、机の上に置いた鞄の影が長く伸びている。主人公の太郎が一人、窓際の席で頬杖をついている。",
  "太郎「今日も、誰も来なかったな」",
  "",
  "□コマ2「部員募集」の貼り紙のアップ",
  "　色あせた貼り紙。端がめくれている。",
  "",
  "■2ページ",
  "",
  "□コマ1",
  "　教室の戸が勢いよく開く。",
  "転校生の女の子「すみません、ここが文芸部ですか。貼り紙を見て来たんですけど、まだ部員を募集していますか」",
  "太郎「……え？」",
  "",
  "□コマ2",
  "　太郎、驚いて立ち上がる。椅子が倒れる。",
  "生徒会長（声のみ）「その部は、今月で廃部の予定ですよ」",
].join("\n");

let browser: Browser | undefined;

async function openHtml(html: string, viewport: { width: number; height: number }): Promise<Page> {
  if (!browser) throw new Error("ブラウザが起きていません");
  const dir = path.join(lookDir(), "_html");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `tmp-${Date.now()}.html`);
  await writeFile(file, html, "utf8");
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1.5 });
  await page.goto("file:///" + file.replace(/\\/g, "/"));
  await page.waitForFunction(() => document.querySelectorAll("#print-pages .page").length > 0, null, { timeout: 60_000 });
  await page.waitForTimeout(800);
  return page;
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
  await page.screenshot({ path: path.join(lookDir(), `${name}.png`), fullPage: true, clip: box });
}

describe.skipIf(!lookEnabled)("見た目の写真：漫画の原作の紙（台本と同じ組み方）", () => {
  beforeAll(async () => {
    await mkdir(lookDir(), { recursive: true });
    const executablePath = EDGE_PATHS.find((candidate) => existsSync(candidate));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("公募の納品用：絵の説明の3字下げ、台詞の人物名の欄とぶら下げ、ページ・コマはそのまま", async () => {
    const page = await openHtml(
      buildGridPrintHtml({
        workTitle: "放課後の文芸部",
        episodes: [{ heading: "第1話　貼り紙", body: MANGA_BODY, notation: "curly" }],
        paper: "a4-landscape",
        grid: GRID40,
        kind: "manga",
      }),
      { width: 1700, height: 1100 }
    );
    await savePages(page, "漫画の原作-公募40x40-A4横", 1, 1);
    await page.close();
  });

  test("読む紙（文庫・縦書き）：同じ組み方と書体", async () => {
    const page = await openHtml(
      buildPrintHtml({
        workTitle: "放課後の文芸部",
        episodes: [{ heading: "第1話　貼り紙", body: MANGA_BODY, notation: "curly" }],
        preset: "bunko-vertical",
        kind: "manga",
      }),
      { width: 1500, height: 1000 }
    );
    await savePages(page, "漫画の原作-読む紙-文庫縦", 1, 3);
    await page.close();
  });
});
