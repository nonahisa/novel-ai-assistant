/**
 * EPUBエディターで焼いた表紙の題名が、**字ごとに90度横倒しにならない**（画面の自動テスト、設計書6.65.9・6.113）。
 *
 * 実機確認リスト 5487 の下の【不具合の疑い】（2026-10-15、`look/coverTitleBadgeLook.test.ts` の写真で
 * 本体が見つけた）を機械へ移したもの。縦書きの本（`writingMode: "vertical"`）では、表紙の面の
 * `.epub-page.vertical` が `writing-mode: vertical-rl` を持ち、焼く先の canvas がそれを受け継いでいた。
 * Chromium の canvas は、要素の書字方向が縦だと `fillText` の字を縦組み用に横倒しで描くので、
 * 題名を縦に並べても横に並べても、1字ずつ寝た形で焼けていた。
 *
 * **物差し**：題名を「一」1字にして焼く。「一」は横に長い字なので、立っていれば墨の外接矩形は
 * 横長、横倒しなら縦長になる。字の形そのものに頼るので、置き場所や大きさが変わっても言い切れる。
 * 題名は既定の「上・中央・大」に置かれるので、作者名（既定で右下）を拾わないよう上半分だけを測る。
 *
 * 縦に並べた題名（既定）と、横に並べた題名の両方で見る。本の設計図と元イラストは起こす前に置く。
 * **AI は呼ばない。**
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { defaultBookConfig } from "../../src/models/book";
import { decodePng, openEpubEditor, samplePicture } from "./look/epubLookSupport";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

/** 横に長い字。立っていれば横長、寝ていれば縦長の墨になる */
const TITLE = "一";

const bakedPath = (session: E2ESession) => path.join(session.workFolder, "設定", "書籍", "表紙_合成済み.png");

/** 上半分の白い墨の外接矩形。見本の絵のいちばん明るい所でも (180,200,230) なので、白はそれより上で分かれる */
function titleInk(bytes: Buffer): { width: number; height: number; left: number; right: number; top: number; bottom: number } {
  const { width, height, rgba } = decodePng(bytes);
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < Math.floor(height / 2); y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (rgba[at] < 240 || rgba[at + 1] < 240 || rgba[at + 2] < 240) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { width: right - left + 1, height: bottom - top + 1, left, right, top, bottom };
}

async function expectUpright(session: E2ESession, what: string): Promise<void> {
  const ink = titleInk(await readFile(bakedPath(session)));
  const where = `${what}：墨 x=${ink.left}〜${ink.right}・y=${ink.top}〜${ink.bottom}（${ink.width}×${ink.height}）`;
  expect(ink.right, `題名の墨が見つかりません。${where}`).toBeGreaterThanOrEqual(0);
  // 「一」の横棒は縦の何倍も長い。寝ていれば縦長になる（2026-10-15 の写真の形）
  expect(ink.width, `題名「一」が横倒しに焼けています（墨が縦長）。${where}`).toBeGreaterThan(ink.height * 2);
}

async function waitBaked(session: E2ESession, before: number | undefined, what: string): Promise<void> {
  await waitUntil(
    async () => {
      const now = (await stat(bakedPath(session)).catch(() => undefined))?.mtimeMs;
      return now !== undefined && now !== before;
    },
    `${what}の焼いた画像ができる`,
    20_000
  );
  // 書き終わりを待つ（読みかけの PNG を測らない）
  await session.page.waitForTimeout(1500);
}

test("縦書きの本の表紙で、題名「一」を縦にも横にも立てたまま焼く（字ごとに横倒しにならない）", async () => {
  await withVsCode(
    "表紙の題名の字の向き",
    [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
    async (session) => {
      const { page } = session;
      const epub = await openEpubEditor(page, TITLE);
      await epub.locator("#blockList .rail-row", { has: epub.locator(".rail-label", { hasText: /^表紙$/ }) }).first().click();
      const bake = epub.locator("#bakeFront");
      await waitUntil(async () => await bake.isVisible(), "［表紙を焼く］が出る", 20_000);

      // 既定は「大・縦」
      const vertical = epub.locator("#front-title-vertical");
      if (!(await vertical.isChecked())) await vertical.check();
      await page.waitForTimeout(1200);
      await bake.click();
      await waitBaked(session, undefined, "縦");
      await expectUpright(session, "縦に並べた題名");

      // 横にして焼き直す
      const before = (await stat(bakedPath(session))).mtimeMs;
      await vertical.uncheck();
      await page.waitForTimeout(1200);
      await bake.click();
      await waitBaked(session, before, "横");
      await expectUpright(session, "横に並べた題名");
    },
    {
      // 題名は作品名から来る（book.json の題名が空でなければそちらが勝つので、同じものを書く）
      workTitle: TITLE,
      prepareWork: async ({ workFolder }) => {
        await mkdir(path.join(workFolder, "素材"), { recursive: true });
        await writeFile(path.join(workFolder, "素材", "表紙.png"), samplePicture());
        await mkdir(path.join(workFolder, "設定", "書籍"), { recursive: true });
        // 既定の本は縦書き（`writingMode: "vertical"`）。不具合が出るのはこちら
        const config = { ...defaultBookConfig(TITLE), coverImagePath: "素材/表紙.png" };
        await writeFile(path.join(workFolder, "設定", "書籍", "book.json"), JSON.stringify(config, null, 2), "utf8");
      },
    }
  );
}, 180_000);
