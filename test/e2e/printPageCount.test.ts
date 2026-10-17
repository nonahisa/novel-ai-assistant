/**
 * 印刷用 PDF の紙：帯の「全Nページ（扉を含む）」とブラウザの印刷（`page.pdf`）のページ数が合う／
 * 面の大きさが紙と合う／19話・約4万字で面が並ぶまでの秒数（画面の自動テスト、設計書6.113。2026-10-18）。
 *
 * 実機確認リストの
 * - 「画面の上の黄色い帯に『全Nページ（扉を含む）』…」（帯の数と印刷のページ数）
 * - 「A5・縦書き、A4・横書きでも、面の大きさが紙と合っていて…」（判型3つで同じ数え方）
 * - 「19話・4万字級の作品で、ブラウザが開いてから面が並ぶまでに…」（秒数）
 * の、機械で測れる部分を移したもの。
 *
 * **VS Code は起こさない。** 製品が書き出す HTML は、組み立てる関数（`buildPrintHtml`）が返す1枚の文字列そのもの。
 * 作者の画面の外で、Edge（なければ playwright の Chromium）の**ヘッドレス**で開く。本物のコマンドは書き出したあとに
 * 既定のブラウザを開いてしまうので使わない（`look/printLook.test.ts` と同じ道）。
 * **作者の作品・確認用コピーは読まない。** 19話の本文は、このファイルの中で作る作り物（約4万字）。
 *
 * 見ないもの：待たされると感じるか（作者の感覚）、印刷画面の既定のままで判型が合うか（ブラウザの印刷画面）。
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildPrintHtml, PRINT_PRESETS, type PrintEpisode, type PrintPreset } from "../../src/core/printHtml";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const SENTENCES = [
  "朝の駅は、まだ眠っているようだった。",
  "「{改札|かいさつ}の向こうで待っています」と彼女は言った。",
  "彼は黙って頷き、{{古い切符}}を握りしめた。",
  "3月5日の{夜明け前|よあけまえ}、雨の中に残っていたのは足音だけだった。",
  "ホームの時計が零時を指し、最終電車の灯りが遠ざかっていく。",
  "「どうして、ここまで来たんですか。」と問われても、答えられなかった。",
  "それでも、足は前へ出た。雨の音だけが、彼の背中を押していた。",
  "「行こう」と彼は小さく言った。彼女は、うなずいた。",
];

/** 1話ぶんの本文（約 chars 字になるまで段落を重ねる） */
function episodeBody(chars: number, seed: number): string {
  const lines: string[] = [];
  let total = 0;
  for (let p = 0; total < chars; p++) {
    let text = "　";
    for (let i = 0; i < 5 + ((p + seed) % 4); i++) text += SENTENCES[(p + i + seed) % SENTENCES.length];
    lines.push(text);
    total += text.length;
  }
  return lines.join("\n");
}

/** 19話・約4万字 */
const EPISODES: PrintEpisode[] = Array.from({ length: 19 }, (_, index) => ({
  heading: `第${index + 1}話　作り物の話`,
  body: episodeBody(2_100, index),
  notation: "curly" as const,
}));

let browser: Browser | undefined;

async function openHtml(html: string): Promise<{ page: Page; arrangeMs: number }> {
  if (!browser) throw new Error("ブラウザが起きていません");
  const dir = path.join(os.tmpdir(), "novelai-e2e-print");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}.html`);
  await writeFile(file, html, "utf8");
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const started = Date.now();
  await page.goto("file:///" + file.replace(/\\/g, "/"));
  // 面が並び終わる＝帯の「全Nページ」が出る（`countPages` は割り終わりに書く）
  await page.waitForFunction(() => /全\d+ページ/.test(document.getElementById("print-page-count")?.textContent ?? ""), null, { timeout: 120_000 });
  const arrangeMs = Date.now() - started;
  return { page, arrangeMs };
}

function bandCount(text: string): number {
  const match = /全(\d+)ページ/.exec(text);
  return match ? Number(match[1]) : -1;
}

/** PDF のページ数（`/Type /Page`。親の `/Pages` は数えない） */
function pdfPageCount(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** PDF の1ページ目の紙の大きさ（mm。`/MediaBox [0 0 W H]` はポイント） */
function pdfPaperMm(buffer: Buffer): { width: number; height: number } | undefined {
  const match = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(buffer.toString("latin1"));
  if (!match) return undefined;
  return { width: (Number(match[1]) * 25.4) / 72, height: (Number(match[2]) * 25.4) / 72 };
}

function mmOf(size: string): { width: number; height: number } {
  const [w = "", h = ""] = size.split(/\s+/);
  return { width: Number.parseFloat(w), height: Number.parseFloat(h) };
}

describe("印刷用 PDF の紙：帯のページ数・面の大きさ・面が並ぶまでの秒数", () => {
  beforeAll(async () => {
    const executablePath = EDGE_PATHS.find((candidate) => existsSync(candidate));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const preset of PRINT_PRESETS) {
    test(`${preset.label}：帯の「全Nページ」＝面の数＝ブラウザの印刷（PDF）のページ数。面と PDF の紙の大きさが判型どおり`, async () => {
      const { page, arrangeMs } = await openHtml(buildPrintHtml({ workTitle: "作り物の本", episodes: EPISODES, preset: preset.id as PrintPreset }));
      try {
        const facts = await page.evaluate(() => ({
          band: document.getElementById("print-page-count")?.textContent ?? "",
          pages: document.querySelectorAll("#print-pages .page").length,
          first: (() => {
            const el = document.querySelector("#print-pages .page") as HTMLElement | null;
            const rect = el?.getBoundingClientRect();
            return rect ? { width: rect.width, height: rect.height } : null;
          })(),
        }));
        const bandPages = bandCount(facts.band);
        expect(bandPages, `帯の文が読めません（${JSON.stringify(facts.band)}）`).toBeGreaterThan(1);
        expect(facts.pages, `帯（${facts.band}）と、画面の面（.page）の数が違います`).toBe(bandPages);

        // 面の大きさ：CSS の mm（96dpi の px）と、紙の寸が合う（±2px）
        const paper = mmOf(preset.size);
        const wantWidth = (paper.width * 96) / 25.4;
        const wantHeight = (paper.height * 96) / 25.4;
        expect(facts.first, "面の大きさが取れません").not.toBeNull();
        expect(Math.abs((facts.first?.width ?? 0) - wantWidth), `面の幅 ${facts.first?.width}px が紙（${preset.size}）の ${wantWidth.toFixed(1)}px と違います`).toBeLessThanOrEqual(2);
        expect(Math.abs((facts.first?.height ?? 0) - wantHeight), `面の高さ ${facts.first?.height}px が紙（${preset.size}）の ${wantHeight.toFixed(1)}px と違います`).toBeLessThanOrEqual(2);

        // ブラウザの印刷（PDF）：ページ数が帯と同じ。紙の寸が判型どおり
        const buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        const pdfPages = pdfPageCount(buffer);
        expect(pdfPages, `帯は全${bandPages}ページなのに、ブラウザの印刷（PDF）は ${pdfPages} ページです`).toBe(bandPages);
        const mm = pdfPaperMm(buffer);
        expect(mm, "PDF の紙の大きさ（MediaBox）が読めません").toBeDefined();
        expect(Math.abs((mm?.width ?? 0) - paper.width), `PDF の紙の幅 ${mm?.width.toFixed(1)}mm が ${paper.width}mm と違います`).toBeLessThanOrEqual(1);
        expect(Math.abs((mm?.height ?? 0) - paper.height), `PDF の紙の高さ ${mm?.height.toFixed(1)}mm が ${paper.height}mm と違います`).toBeLessThanOrEqual(1);

        // 19話・約4万字で、ブラウザが開いてから面が並ぶまでの秒数（測った値を残す。上限は固まったと言える大きさ）
        const chars = EPISODES.reduce((sum, episode) => sum + episode.body.length, 0);
        // 測った値は一時フォルダーの「秒数.txt」へ足す（走らせた出力には console.log が出ないため）
        await appendFile(
          path.join(os.tmpdir(), "novelai-e2e-print", "秒数.txt"),
          `${preset.label}：${EPISODES.length}話・${chars}字 → 面が並ぶまで ${(arrangeMs / 1000).toFixed(2)} 秒（${bandPages}ページ）
`,
          "utf8"
        );
        expect(arrangeMs, `面が並ぶまで ${(arrangeMs / 1000).toFixed(1)} 秒かかりました（30秒を超えると固まったように見える）`).toBeLessThan(30_000);
      } finally {
        await page.close();
      }
    }, 180_000);
  }
});
