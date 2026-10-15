/**
 * 束 E22（docs/measurements/2026-10-15-field-triage-unmarked2.md）：表紙の長い題名と、暗いテーマの未反映件数の写真。
 *
 * 実機確認リストの 5487「折り返しの見た目（題名30〜60文字、大・横と縦）」と、5488 の見比べ用の短い題名、
 * 4966「暗いテーマでも読めるか（未反映件数のオレンジ）」。**読めるかの判断は作者が写真で行う。**
 * ここで機械が確かめるのは、言い切れることだけ：
 *
 * - 表紙：焼いた画像の題名の墨（白）が、**四辺に余白を残して枠の内側に収まる**（切れていない）。
 *   行・列が重ならないことは `unit/cross/coverCompose.test.ts` が見ているので、ここでは言い直さない
 * - 未反映件数：詳細メニューの「資料管理」の行に件数の印が出て、その色と左の列の地の色の
 *   **明るさの比**（WCAG の式）を測ってメモへ残す。比が UI の部品の下限（3:1）を割っていたら落とす
 *
 * **字の向きは見ていない。** 2026-10-15 の写真では、縦でも横でも題名の字が1字ずつ90度横倒しに
 * 焼けていた（焼く先の canvas が、親の `.epub-page.vertical` から `writing-mode: vertical-rl` を受け継いでいる。
 * メモの「焼く前の canvas の書字方向」）。字形の向きを機械で言い切る物差しが無いので、写真で作者と本体が見る。
 *
 * `NOVELAI_LOOK=1` のときだけ動く（`lookSupport.ts`）。作品は使い捨ての見本だけ。AI は呼ばない。
 * 写真の置き場は `NOVELAI_LOOK_DIR`（2026-10-15 は `novel-ai-bench\look\2026-10-15`）。
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { describe, expect, test } from "vitest";
import { defaultBookConfig } from "../../../src/models/book";
import { emptyCharacter } from "../../../src/models/character";
import { AIWRITER_DIR } from "../../../src/models/types";
import { showSidebar, SIDEBAR_LAUNCH, treeRow } from "../support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { decodePng, openEpubEditor, samplePicture } from "./epubLookSupport";
import { lookDir, lookEnabled, lookNote, setPane, setRow, shootPage, shootWithZoom } from "./lookSupport";

// ───────────────────────── 表紙の題名（5487・5488） ─────────────────────────

/** 題名の長さごとの見本。30字と60字は 5487、短いものは 5488 の見比べ用 */
const TITLES: ReadonlyArray<{ tag: string; title: string; chars: number }> = [
  { tag: "5488-短い題名5字", title: "図書室の夏", chars: 5 },
  { tag: "5487-30字", title: "放課後の図書室で出会った少女と消えた七冊の本をめぐる夏の物語", chars: 30 },
  {
    tag: "5487-60字",
    title: "放課後の図書室で出会った少女と消えた七冊の本をめぐる夏の物語～転生した司書見習いは魔法の栞で失われた頁を取り戻せるのか～",
    chars: 60,
  },
];

const bakedPath = (session: E2ESession) => path.join(session.workFolder, "設定", "書籍", "表紙_合成済み.png");

/** 題名の墨（白）の範囲。見本の絵はいちばん明るい所でも (180,200,230) なので、白はそれより上で分かれる */
interface InkBox {
  width: number;
  height: number;
  inkPixels: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 墨のある行（横書き）／列（縦書き）のまとまり。字の中の隙間でも割れるので数の目安にとどめる */
  bands: number;
}

function inkBox(bytes: Buffer, vertical: boolean): InkBox {
  const { width, height, rgba } = decodePng(bytes);
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  let inkPixels = 0;
  const lineHasInk = new Array<boolean>(vertical ? width : height).fill(false);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (rgba[at] < 240 || rgba[at + 1] < 240 || rgba[at + 2] < 240) continue;
      inkPixels++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      lineHasInk[vertical ? x : y] = true;
    }
  }
  let bands = 0;
  for (let i = 0; i < lineHasInk.length; i++) if (lineHasInk[i] && (i === 0 || !lineHasInk[i - 1])) bands++;
  return { width, height, inkPixels, left, right, top, bottom, bands };
}

/** 焼き上がり（ファイルの更新時刻が `before` から変わる）を待つ */
async function waitBaked(session: E2ESession, before: number | undefined, what: string): Promise<void> {
  await waitUntil(
    async () => {
      const now = (await stat(bakedPath(session)).catch(() => undefined))?.mtimeMs;
      return now !== undefined && now !== before;
    },
    `${what}の焼いた画像ができる`,
    20_000
  );
  // 書き終わりを待つ（大きさが落ち着くまで）
  await session.page.waitForTimeout(1500);
}

/** 面の見出しと絵が写真に収まるよう、プレビューを窓の上へ転がす */
async function showFace(epub: Frame): Promise<void> {
  await epub.evaluate(() => {
    const frame = document.querySelector(".page-frame");
    if (frame) frame.scrollIntoView({ block: "start" });
  });
  await epub.page().waitForTimeout(400);
}

/** 焼いた画像そのもの・窓の写真・プレビューの枠だけの写真を残し、墨の範囲を確かめる */
async function recordBake(session: E2ESession, epub: Frame, name: string, vertical: boolean, chars: number): Promise<void> {
  await copyFile(bakedPath(session), path.join(lookDir(), `${name}-焼いた画像.png`));
  await showFace(epub);
  await shootPage(session.page, name);
  await epub
    .locator(".page-frame")
    .first()
    .screenshot({ path: path.join(lookDir(), `${name}-拡大.png`) })
    .catch(async (error: unknown) => lookNote(`[${name}] プレビューの枠だけの写真が撮れません：${String(error)}`));

  const box = inkBox(await readFile(bakedPath(session)), vertical);
  await lookNote(
    `[${name}] 題名 ${chars}字・${vertical ? "縦" : "横"}・大：画像 ${box.width}×${box.height}、` +
      `墨 x=${box.left}〜${box.right}・y=${box.top}〜${box.bottom}（${box.inkPixels}画素）、` +
      `${vertical ? "列" : "行"}のまとまり ${box.bands}`
  );
  const where = `${name}（画像 ${box.width}×${box.height}、墨 x=${box.left}〜${box.right}・y=${box.top}〜${box.bottom}）`;
  // 題名が焼き込まれていること（白が1つも無ければ、測る相手が無い）
  expect(box.inkPixels, `墨が見つかりません：${where}`).toBeGreaterThan(0);
  // 四辺に余白が残る＝枠で切れていない（0.73.6 では x=0〜1713 で両端が切れていた）
  expect(box.left, `左で切れています：${where}`).toBeGreaterThan(0);
  expect(box.top, `上で切れています：${where}`).toBeGreaterThan(0);
  expect(box.right, `右で切れています：${where}`).toBeLessThan(box.width - 1);
  expect(box.bottom, `下で切れています：${where}`).toBeLessThan(box.height - 1);
}

describe.skipIf(!lookEnabled)("見た目の写真：表紙の長い題名（束 E22）", () => {
  for (const { tag, title, chars } of TITLES) {
    test(`表紙を「大」で、縦と横で焼く（${tag}）`, async () => {
      // 見本の字数が崩れると、30字・60字を撮ったことにならない
      expect([...title].length).toBe(chars);
      await mkdir(lookDir(), { recursive: true });
      await withVsCode(
        `見た目の写真：表紙の題名 ${tag}`,
        [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
        async (session) => {
          const { page } = session;
          const epub = await openEpubEditor(page, title);
          await epub.locator("#blockList .rail-row", { has: epub.locator(".rail-label", { hasText: /^表紙$/ }) }).first().click();
          const bake = epub.locator("#bakeFront");
          await waitUntil(async () => await bake.isVisible(), "［表紙を焼く］が出る", 20_000);

          // 既定は「大・縦」（`defaultCoverLayout`）。焼く前にそうなっていることを確かめてから焼く
          const vertical = epub.locator("#front-title-vertical");
          if (!(await vertical.isChecked())) await vertical.check();
          await page.waitForTimeout(1200);
          // 縦の題名の字が横倒しに焼けていた（2026-10-15 に見つけた）。原因を追えるよう、
          // 焼く先の canvas とその親の書字方向をメモへ残す
          await lookNote(
            `[${tag}] 焼く前の canvas の書字方向：${await epub.evaluate(() => {
              const canvas = document.getElementById("canvas-front");
              const chain: string[] = [];
              for (let node: Element | null = canvas; node && chain.length < 8; node = node.parentElement) {
                const style = getComputedStyle(node);
                chain.push(`${node.tagName.toLowerCase()}${node.id ? "#" + node.id : ""}${node.className ? "." + String(node.className).split(/\s+/).join(".") : ""}=${style.writingMode}/${style.textOrientation}`);
              }
              return canvas ? chain.join(" < ") : "canvas-front が見つかりません";
            })}`
          );
          await bake.click();
          await waitBaked(session, undefined, "縦");
          await recordBake(session, epub, `${tag}-大-縦`, true, chars);

          // 横にして焼き直す
          const before = (await stat(bakedPath(session))).mtimeMs;
          await vertical.uncheck();
          await page.waitForTimeout(1200);
          await bake.click();
          await waitBaked(session, before, "横");
          await recordBake(session, epub, `${tag}-大-横`, false, chars);
        },
        {
          windowSize: { width: 1400, height: 1000 },
          // 題名は作品名から来る（book.json の題名が空でなければそちらが勝つので、同じものを書く）
          workTitle: title,
          prepareWork: async ({ workFolder }) => {
            await mkdir(path.join(workFolder, "素材"), { recursive: true });
            await writeFile(path.join(workFolder, "素材", "表紙.png"), samplePicture());
            await mkdir(path.join(workFolder, "設定", "書籍"), { recursive: true });
            const config = { ...defaultBookConfig(title), coverImagePath: "素材/表紙.png" };
            await writeFile(path.join(workFolder, "設定", "書籍", "book.json"), JSON.stringify(config, null, 2), "utf8");
          },
        }
      );
    });
  }
});

// ───────────────────────── 未反映件数の色（4966） ─────────────────────────

/** 置く承認待ちの数。詳細メニューの「資料管理」に、この数の印が出る */
const PENDING_COUNT = 3;

/** 承認待ちの人物を、製品と同じ置き場・同じ名前で置く（`PendingUpdateStore`） */
async function stagePending(workFolder: string): Promise<void> {
  const folder = path.join(workFolder, AIWRITER_DIR, "pending-characters");
  await mkdir(folder, { recursive: true });
  const names = ["灯", "澪", "朔"];
  for (let i = 0; i < PENDING_COUNT; i++) {
    const character = emptyCharacter(`char_00${i + 1}`, names[i]);
    await writeFile(path.join(folder, `${character.id}.json`), `${JSON.stringify(character, null, 2)}\n`, "utf8");
  }
}

interface BadgeColors {
  /** 行の中で、疑似要素（::after）に字の入っているもの（VS Code の印の描き方） */
  badges: Array<{ content: string; color: string }>;
  /** 行の名前（label-name）の色。印の色は名前にも付く */
  labelColor: string;
  /** 左の列の地の色 */
  sidebarBackground: string;
  /** 行の DOM の切れ端（印の在りかが版で変わったときに読むため） */
  html: string;
}

async function badgeColors(page: Page, head: string): Promise<BadgeColors> {
  return treeRow(page, head).evaluate((row) => {
    const badges: Array<{ content: string; color: string }> = [];
    for (const element of [row, ...Array.from(row.querySelectorAll("*"))]) {
      const after = getComputedStyle(element, "::after");
      const content = after.content;
      if (content && content !== "none" && content !== "normal" && content !== '""') {
        badges.push({ content, color: after.color });
      }
    }
    const name = row.querySelector(".label-name");
    const sidebar = document.querySelector(".part.sidebar");
    return {
      badges,
      labelColor: name ? getComputedStyle(name).color : "",
      sidebarBackground: sidebar ? getComputedStyle(sidebar).backgroundColor : "",
      html: row.outerHTML.slice(0, 1200),
    };
  });
}

/** `rgb(r, g, b)` を読む */
function parseRgb(text: string): [number, number, number] | undefined {
  const match = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** WCAG 2 の明るさの比 */
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const luminance = ([r, g, bl]: [number, number, number]) => {
    const channel = (value: number) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: ReadonlyArray<{ tag: string; settings: Record<string, unknown> }> = [
  // 画面の自動テストの既定は暗いテーマ（Dark Modern）。4966 の本題
  { tag: "暗いテーマ", settings: {} },
  // 見比べ用
  { tag: "明るいテーマ", settings: { "workbench.colorTheme": "Default Light Modern" } },
];

describe.skipIf(!lookEnabled)("見た目の写真：詳細メニューの未反映件数（束 E22）", () => {
  for (const { tag, settings } of THEMES) {
    test(`資料管理の行に付く未反映件数（${tag}）`, async () => {
      await withVsCode(
        `見た目の写真：未反映件数 ${tag}`,
        [{ name: "001_はじまり.txt", text: "一行目の文。\n" }],
        async (session) => {
          const { page } = session;
          await showSidebar(page, E2E_WORK_TITLE);
          await setPane(page, "作品一覧", false);
          await setPane(page, "簡単ステップメニュー", false);
          await setRow(page, "資料管理", true);
          await setRow(page, "資料抽出", true);

          let colors: BadgeColors | undefined;
          await waitUntil(
            async () => {
              colors = await badgeColors(page, "資料管理");
              return colors.badges.some((badge) => badge.content.includes(String(PENDING_COUNT)));
            },
            `「資料管理」の行に未反映件数 ${PENDING_COUNT} の印が出る`,
            30_000
          ).catch(async (error: unknown) => {
            // 印の在りかが読めないときは、そのときの行の DOM を添えて落とす（離れた機械でも原因が読めるように）
            throw new Error(`${String(error)}\n行の様子：${JSON.stringify(colors)}`);
          });
          const found = colors as BadgeColors;
          const badge = found.badges.find((item) => item.content.includes(String(PENDING_COUNT)));
          const badgeRgb = badge ? parseRgb(badge.color) : undefined;
          const backgroundRgb = parseRgb(found.sidebarBackground);
          const ratio = badgeRgb && backgroundRgb ? contrastRatio(badgeRgb, backgroundRgb) : undefined;
          await lookNote(
            `[4966] ${tag}：印 ${badge?.content} の色 ${badge?.color}、名前の色 ${found.labelColor}、` +
              `左の列の地 ${found.sidebarBackground}、明るさの比 ${ratio?.toFixed(2) ?? "測れず"}`
          );
          await lookNote(`[4966] ${tag}：行の DOM ${found.html}`);
          await shootWithZoom(page, `4966-未反映件数-${tag}`, { x: 0, y: 30, width: 350, height: 500 });

          expect(ratio, `色が読めません：${JSON.stringify(found)}`).toBeDefined();
          // UI の部品の明るさの比の下限（WCAG 1.4.11 の 3:1）。読めるかの判断そのものは作者が写真で行う
          expect(ratio as number).toBeGreaterThanOrEqual(3);
        },
        {
          ...SIDEBAR_LAUNCH,
          settings: { ...SIDEBAR_LAUNCH.settings, ...settings },
          windowSize: { width: 1280, height: 800 },
          prepareWork: ({ workFolder }) => stagePending(workFolder),
        }
      );
    });
  }
});
