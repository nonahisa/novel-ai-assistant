/**
 * 実機確認リストの 〔作者の手：見〕 のうち、印刷の紙の見た目を**作者の本物の作品（の写し）**で
 * 写真に撮る（2026-10-17。作り物の文で撮った `printLook.test.ts` の続き。判断そのものはしない）。
 *
 * **VS Code は起こさない。** 紙は製品の組み立て関数（`buildPrintHtml`・`buildGridPrintHtml`）が
 * 返す1枚の HTML で、話の切り分けも製品と同じ `bookChaptersOf`・`notationModeFor` を通す。
 * 開くのは Edge（なければ playwright の Chromium）で、作者の画面の外。
 *
 * `NOVELAI_LOOK=1` と、作品フォルダーの `NOVELAI_LOOK_WORK`（確認用コピー。作者の原稿は渡さない）が
 * 揃ったときだけ動く。作品は読むだけで、1字も書かない。
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bookChaptersOf } from "../../../src/core/bookChapters";
import { parseEpisodeFileName } from "../../../src/core/episodeParser";
import { notationModeFor } from "../../../src/core/manuscriptRender";
import type { GridOptions } from "../../../src/core/manuscriptGrid";
import { buildGridPrintHtml, GRID_MARGINS, type GridPaper } from "../../../src/core/printGridHtml";
import { buildPrintHtml, type PrintEpisode } from "../../../src/core/printHtml";
import type { EpisodeFile } from "../../../src/models/types";
import { lookDir, lookEnabled } from "./lookSupport";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const WORK = process.env.NOVELAI_LOOK_WORK ?? "";

let browser: Browser | undefined;

/** 作品の話を、書き出しと同じ切り分けで並べる（ファイル名の順） */
async function loadEpisodes(folder: string, only?: RegExp): Promise<PrintEpisode[]> {
  const names = (await readdir(folder))
    .filter((name) => /^episode_.*\.(md|txt)$/.test(name))
    .filter((name) => !only || only.test(name))
    .sort();
  const chapters: PrintEpisode[] = [];
  for (const fileName of names) {
    const filePath = path.join(folder, fileName);
    const parsed = parseEpisodeFileName(fileName);
    const episode = { ...parsed, filePath, fileName, ext: path.extname(fileName) } as unknown as EpisodeFile;
    const text = await readFile(filePath, "utf8");
    for (const part of bookChaptersOf(episode, text)) {
      chapters.push({ heading: part.heading, body: part.body, notation: notationModeFor(fileName) });
    }
  }
  return chapters;
}

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

/** 文を含む最初の面の番号（0から）。無ければ -1 */
async function pageWith(page: Page, text: string): Promise<number> {
  return page.evaluate((needle) => {
    const pages = Array.from(document.querySelectorAll("#print-pages .page"));
    return pages.findIndex((el) => (el.textContent ?? "").includes(needle));
  }, text);
}

/** 面の数と、各面の頭の1字（小さい仮名・「ー」・句読点で始まる面を拾う） */
async function pageHeads(page: Page): Promise<{ pages: number; badHeads: { page: number; head: string }[] }> {
  return page.evaluate(() => {
    const pages = Array.from(document.querySelectorAll("#print-pages .page")) as HTMLElement[];
    const bad = /^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶー、。，．・：；？！）」』】〕］｝〉》]/;
    const badHeads: { page: number; head: string }[] = [];
    pages.forEach((el, i) => {
      const body = el.querySelector(".page-body, .body, .content") ?? el;
      const head = (body.textContent ?? "").replace(/\s+/g, "").slice(0, 12);
      if (bad.test(head)) badHeads.push({ page: i, head });
    });
    return { pages: pages.length, badHeads };
  });
}

async function savePdf(page: Page, name: string): Promise<number> {
  const file = path.join(lookDir(), `${name}.pdf`);
  const buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await writeFile(file, buffer);
  return (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

const GRID40: GridOptions = { columns: 40, rows: 40, hanging: true, vertical: true };
const GRID20: GridOptions = { columns: 20, rows: 20, hanging: true, vertical: true };

describe.skipIf(!lookEnabled || !WORK)("見た目の写真：本物の作品の紙", () => {
  beforeAll(async () => {
    await mkdir(lookDir(), { recursive: true });
    const executablePath = EDGE_PATHS.find((candidate) => existsSync(candidate));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("読む紙（文庫・縦書き）：ページ頭の小さい仮名・「ー」、ルビ・傍点・縦中横", async () => {
    const episodes = await loadEpisodes(WORK);
    expect(episodes.length).toBeGreaterThan(0);
    const page = await openHtml(
      buildPrintHtml({ workTitle: path.basename(WORK), episodes, preset: "bunko-vertical" }),
      { width: 1500, height: 1000 }
    );
    const heads = await pageHeads(page);
    await writeFile(path.join(lookDir(), "792-読む紙-面の頭.json"), JSON.stringify(heads, null, 2), "utf8");
    await savePages(page, "792-読む紙-文庫縦-本文の最初", 1, 3);
    for (const badHead of heads.badHeads.slice(0, 3)) {
      await savePages(page, `792-読む紙-頭が気になる面-${badHead.page + 1}枚目`, Math.max(0, badHead.page - 1), badHead.page);
    }
    const ruby = await pageWith(page, "ルビ傍点の確認");
    if (ruby >= 0) await savePages(page, "803-読む紙-ルビ傍点", ruby, ruby + 1);
    const tcy = await pageWith(page, "縦中横の確認");
    if (tcy >= 0) await savePages(page, "792-803-読む紙-縦中横", tcy, tcy + 1);
    await savePdf(page, "792-読む紙-文庫縦-全体");
    await page.close();
  });

  async function grid(paper: GridPaper, options: GridOptions, extra: { marginMm?: number; episodes?: PrintEpisode[]; kind?: "script" } = {}): Promise<Page> {
    const episodes = extra.episodes ?? (await loadEpisodes(WORK, /episode_000[1-2]/));
    return openHtml(
      buildGridPrintHtml({
        workTitle: path.basename(WORK),
        episodes,
        paper,
        grid: options,
        ...(extra.marginMm !== undefined ? { marginMm: extra.marginMm } : {}),
        ...(extra.kind ? { kind: extra.kind } : {}),
      }),
      { width: 1700, height: 1100 }
    );
  }

  test("公募の納品用（本物の作品）：40×40 の禁則・ぶら下げ、20×20 のぶら下げと下の帯、余白の普通と狭く", async () => {
    const forty = await grid("a4-landscape", GRID40);
    await savePages(forty, "801-公募40x40-A4横-1枚目", 1, 1);
    await savePages(forty, "801-公募40x40-A4横-2枚目", 2, 2);
    await savePdf(forty, "801-公募40x40-A4横");
    await forty.close();

    const twenty = await grid("a4-landscape", GRID20);
    await savePages(twenty, "802-公募20x20-A4横-1から2枚目", 1, 2);
    await twenty.close();

    for (const margin of GRID_MARGINS) {
      const page = await grid("a4-landscape", GRID40, { marginMm: margin.mm });
      await savePages(page, `804-余白${margin.label}-40x40-A4横`, 1, 1);
      await page.close();
    }
  });

  test("台本の公募の納品用：ト書きの3字下げ（作り物の台本）", async () => {
    const body = [
      "○駅前・夜",
      "",
      "　太郎、改札を抜けて駅前のロータリーへ出る。雨。傘を持っていない。ポケットの中の古い切符を確かめる。",
      "太郎「行こう」",
      "花子「待って。まだ最終電車には間に合うから、走らなくていいよ」",
      "　二人、雨の中へ。",
      "",
      "○ホーム・夜",
      "",
      "　最終電車の灯りが遠ざかっていく。",
    ].join("\n");
    const page = await grid("a4-landscape", GRID40, {
      episodes: [{ heading: "第1話　夜の駅", body, notation: "curly" }],
      kind: "script",
    });
    await savePages(page, "805-台本のト書き3字下げ-A4横", 1, 1);
    await page.close();
  });

  test("台本の公募の納品用：長い人物名と、2行以上の台詞の折り返し（作り物の台本）", async () => {
    const body = [
      "○密倉家の屋敷・応接間・夜",
      "",
      "　文佳、窓の外の雨を見ている。",
      "密倉家の会長「お前が三門の息子か。話は聞いている。学校でのことも、霊媒師のばあさんのことも、全部だ。今さら隠し立てをしても無駄だぞ」",
      "太志「隠すつもりはありません」",
      // 台詞と見分けるのは「「」の前が12字まで（scriptLines.ts）。「お手伝いさん（年配の女性）」は
      // 13字で台詞にならないため、12字の呼び名にした。欄（5字）を超えるので、名前が欄の中で
      // 3行に折り返す（2026-10-17）
      "お手伝いさん（年配の女）「旦那様、お茶をお持ちしました。それから、先ほどお電話がありまして、明日の朝いちばんにもう一度お伺いしたいとのことでございます」",
      // 台詞が1行で終わるのに、名前が2行目に続く例
      "密倉家の会長「下がれ」",
      "　会長、黙って頷く。",
    ].join("\n");
    const page = await grid("a4-landscape", GRID40, {
      episodes: [{ heading: "第2話　屋敷", body, notation: "curly" }],
      kind: "script",
    });
    await savePages(page, "805-台本の長い人物名と長い台詞-A4横", 1, 1);
    await page.close();

    // 読む紙（文庫・縦書き）の台本も同じ組み方（人物名の欄・「「」の下へのぶら下げ・書体）
    const reading = await openHtml(
      buildPrintHtml({
        workTitle: path.basename(WORK),
        episodes: [{ heading: "第2話　屋敷", body, notation: "curly" }],
        preset: "bunko-vertical",
        kind: "script",
      }),
      { width: 1500, height: 1000 }
    );
    await savePages(reading, "805-台本の長い人物名と長い台詞-文庫縦", 1, 2);
    await reading.close();
  });
});
