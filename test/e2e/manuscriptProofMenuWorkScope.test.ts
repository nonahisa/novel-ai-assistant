/**
 * 原稿エディターの上の列の［校正］の残り（画面の自動テスト、設計書6.25・6.80・6.113。実機確認リスト 0.122.0 の
 * 368 行のうち、manuscriptProofMenu が見ていない所。作者の判断 2026-11-02）。
 *
 * 1. 作品一覧で別の作品（作品B）を選んだままでも、「表記ゆれ（作品全体）」は押した原稿の作品（作品A）で走り
 *    （作品Aの操作の記録に「表記ゆれ検知を開始: 作品A」が残り、作品Bの記録には残らない）、
 *    「まとめて校正（作品全体）」は作品Aで選ぶ画面（「校正をまとめて実行：作品A」）が出る。どちらも作品は訊かれない
 * 2. 窓を幅 400px に狭めても、横書き・縦書きの両方で、上の列のボタンは列の見えている幅の中で折り返し、
 *    ［校正］の品書きは見えている幅と面の高さからはみ出さない
 *
 * 見えている幅は、本体の側で測る（VS Code の編集の列には最小幅があり、狭い窓では列の右端が窓の外へ出る。
 * WebView の中からは自分の幅が広く見えるので、面の中だけで測ると隠れた分を見落とす。manuscriptSurfaceNarrow と同じ）。
 *
 * **AI は呼ばない。** 表記ゆれは AI を使わない。まとめて校正は選ぶ画面で取りやめる。見た目の良し悪し
 * （折り返し方が読みやすいか）は作者の手に残す。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { openEpisode } from "./support/manuscriptFrame";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { VERTICAL_LAUNCH, turnVertical } from "./support/verticalFace";
import { E2E_WORK_TITLE, resizeWindows, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, notificationTexts, pressWorkbenchKey, quickInputWaitContext, quickPickTitle } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";
const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";

async function actionLogOf(folder: string): Promise<string> {
  return (await readFile(path.join(folder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

async function menuOpen(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => document.getElementById("menu")?.classList.contains("open") ?? false);
}

async function openProofMenu(frame: Frame): Promise<void> {
  await frame.locator("#proof").click();
  await waitUntil(() => menuOpen(frame), "［校正］の品書きが開く", 5_000);
}

async function pickProofItem(frame: Frame, label: string): Promise<void> {
  await openProofMenu(frame);
  await frame.locator("#menu .item", { hasText: label }).first().click();
}

/** 作品Bを登録し、作品一覧でそちらを選んだままにする */
async function selectOtherWorkInTree(page: Page): Promise<void> {
  await page.keyboard.press(REGISTER_OTHER_PRESS);
  await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
  await clearNotifications(page);
  await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
  const rowB = page.locator(`.monaco-list-row[aria-label*="${OTHER_TITLE}"]`).first();
  await waitUntil(async () => (await rowB.count()) > 0, "作品一覧に作品Bの行が出る", 20_000);
  await rowB.click();
}

function launchWithOther(extra: { keybindings?: Record<string, unknown>[] } = {}) {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  return {
    ...SIDEBAR_LAUNCH,
    keybindings: [...SIDEBAR_LAUNCH.keybindings, registerOther, ...(extra.keybindings ?? [])],
    prepareWork: async ({ workFolder }: { workFolder: string }) => {
      const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
      await mkdir(path.join(otherFolder, "本文"), { recursive: true });
      await writeFile(path.join(otherFolder, "本文", "001_別の作品.txt"), "　別の作品の本文。\n", "utf8");
      registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
    },
  };
}

function otherFolderOf(session: E2ESession): string {
  return path.join(path.dirname(session.workFolder), OTHER_TITLE);
}

test("作品一覧で別の作品を選んだままでも、［校正］の「表記ゆれ（作品全体）」は原稿の作品で走り、「まとめて校正（作品全体）」は原稿の作品で選ぶ画面を出す（作品は訊かれない）", async () => {
  await withVsCode(
    "［校正］の作品全体の2つ",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await selectOtherWorkInTree(page);
      const frame = await openEpisode(page, EPISODE, "静かだった");

      /* ── 表記ゆれ（作品全体）→ 作品Aで走る ── */
      await pickProofItem(frame, "表記ゆれ（作品全体）");
      await waitUntil(async () => (await actionLogOf(session.workFolder)).includes(`表記ゆれ検知を開始: ${E2E_WORK_TITLE}`), "作品Aの操作の記録に「表記ゆれ検知を開始」が残る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(
            `${String(error)}（作品Aの記録の終わり：${(await actionLogOf(session.workFolder)).split("\n").slice(-8).join(" ／ ")}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`
          );
        }
      );
      expect(await actionLogOf(otherFolderOf(session)), "作品Bで表記ゆれ検知が走りました").not.toContain("表記ゆれ検知を開始");
      expect(await quickPickTitle(page), "表記ゆれで作品を訊かれました").not.toBe("作品を選択");
      // 組が無いときの知らせ（または組を選ぶ画面）が出たら閉じる
      if ((await quickPickTitle(page)) !== undefined) await page.keyboard.press("Escape");
      await clearNotifications(page);

      /* ── まとめて校正（作品全体）→ 作品Aで選ぶ画面 ── */
      await pickProofItem(frame, "まとめて校正（作品全体）");
      let title = "";
      await waitUntil(async () => (title = (await quickPickTitle(page)) ?? "").startsWith("校正をまとめて実行"), "まとめて校正の選ぶ画面が出る", 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの窓：${JSON.stringify(title)}）${await quickInputWaitContext(page)}`);
      });
      expect(title).toBe(`校正をまとめて実行：${E2E_WORK_TITLE}`);
      await page.keyboard.press("Escape");
      await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 5_000);
    },
    launchWithOther()
  );
}, 240_000);

/* ───────────── 狭い窓 ───────────── */

const NARROW = { width: 400, height: 700 };

interface BarMeasure {
  /** 本体の側で測った、面の見えている右端（面の左端からの距離） */
  visibleRight: number;
  /** 面自身が思っている幅・高さ */
  frameWidth: number;
  frameHeight: number;
  /** 見えている幅の右へはみ出したボタン（名前と右端） */
  overflowButtons: string[];
  /** 上の列の行数（ボタンの上端の数） */
  barRows: number;
  /** ［校正］のボタンの箱 */
  proof: { left: number; right: number; top: number; bottom: number };
  vertical: boolean;
}

/** 前に出ている原稿エディターの面の、見えている右端（面の左端から測る） */
async function visibleRightOf(page: Page, frame: Frame): Promise<number> {
  const outer = await frame.parentFrame()?.frameElement();
  const box = outer ? await outer.boundingBox() : null;
  if (!box) throw new Error("原稿エディターの枠の大きさが取れません");
  const right = await page.evaluate(() => {
    const active = document.querySelector(".editor-group-container.active") ?? document.querySelector(".editor-group-container");
    const group = active?.getBoundingClientRect();
    return Math.min(group ? group.right : window.innerWidth, window.innerWidth);
  });
  return right - box.x;
}

async function measureBar(page: Page, frame: Frame): Promise<BarMeasure> {
  const visibleRight = await visibleRightOf(page, frame);
  const inside = await frame.evaluate((visible) => {
    const bar = document.getElementById("bar") as HTMLElement;
    const buttons = Array.from(bar.querySelectorAll("button")).filter((button) => (button as HTMLElement).offsetParent !== null) as HTMLElement[];
    const overflowButtons: string[] = [];
    const tops = new Set<number>();
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      tops.add(Math.round(rect.top));
      if (rect.right > visible + 1) overflowButtons.push(`${(button.textContent ?? "").trim()}（右端 ${Math.round(rect.right)}）`);
    }
    const proof = (document.getElementById("proof") as HTMLElement).getBoundingClientRect();
    return {
      frameWidth: document.documentElement.clientWidth,
      frameHeight: document.documentElement.clientHeight,
      overflowButtons,
      barRows: tops.size,
      proof: { left: proof.left, right: proof.right, top: proof.top, bottom: proof.bottom },
      vertical: getComputedStyle(document.getElementById("compose") as HTMLElement).writingMode.startsWith("vertical"),
    };
  }, visibleRight);
  return { visibleRight, ...inside };
}

/**
 * 品書きの箱（縁取りまで含む）と、項目の字の箱（いちばん右・いちばん下）、項目の中で切れた字の数。
 *
 * **はみ出しは縁取りまで含めた箱で測る**（作者の裁定 2026-11-02「直す」）。幅 400px の窓では面が約 188px と
 * 品書きの最小幅（約 190px）より狭く、以前は右の縁取りの 1〜2px が面の外に出ていた。品書きの幅を面に合わせて
 * 狭め、項目の字は折り返して収める。字が読めて押せることは、項目の字の右端と「項目の中で切れた字」で見る
 */
async function menuBox(frame: Frame): Promise<{
  left: number;
  right: number;
  top: number;
  bottom: number;
  items: number;
  textRight: number;
  textBottom: number;
  clippedItems: string[];
}> {
  return frame.evaluate(() => {
    const menu = document.getElementById("menu") as HTMLElement;
    const rect = menu.getBoundingClientRect();
    let textRight = 0;
    let textBottom = 0;
    const clippedItems: string[] = [];
    for (const item of Array.from(menu.querySelectorAll(".item")) as HTMLElement[]) {
      const range = document.createRange();
      range.selectNodeContents(item);
      const box = range.getBoundingClientRect();
      textRight = Math.max(textRight, box.right);
      textBottom = Math.max(textBottom, box.bottom);
      // 字が項目の箱より広い（横へ切れている・隠れている）ものを拾う
      if (item.scrollWidth > item.clientWidth + 1) clippedItems.push(`${(item.textContent ?? "").trim()}（${item.scrollWidth}/${item.clientWidth}）`);
    }
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, items: menu.querySelectorAll(".item").length, textRight, textBottom, clippedItems };
  });
}

/** 狭い窓で上の列と［校正］の品書きを測り、はみ出しが無いことを確かめる */
async function expectFitsNarrow(page: Page, frame: Frame, label: string): Promise<void> {
  // 窓を狭めたあと、面が描き直されて幅が落ち着くまで待つ
  await waitUntil(async () => (await measureBar(page, frame)).visibleRight > 0, `${label}：面の見えている幅が測れる`, 10_000);
  await page.waitForTimeout(500);
  const bar = await measureBar(page, frame);
  const detail = JSON.stringify(bar);
  expect(bar.overflowButtons, `${label}：上の列のボタンが見えている幅の外へはみ出しています（${detail}）`).toEqual([]);
  expect(bar.proof.right, `${label}：［校正］が見えている幅の外にあります（${detail}）`).toBeLessThanOrEqual(bar.visibleRight + 1);

  await openProofMenu(frame);
  const menu = await menuBox(frame);
  const menuDetail = `品書き ${JSON.stringify(menu)}／${detail}`;
  expect(menu.items, `${label}：品書きの項目の数（${menuDetail}）`).toBe(5);
  expect(menu.left, `${label}：品書きが左へはみ出しています（${menuDetail}）`).toBeGreaterThanOrEqual(-1);
  expect(menu.textRight, `${label}：品書きの項目の字が見えている幅の右へはみ出しています（${menuDetail}）`).toBeLessThanOrEqual(bar.visibleRight + 1);
  expect(menu.clippedItems, `${label}：品書きの項目の字が切れています（${menuDetail}）`).toEqual([]);
  // 縁取りまで含めた箱が、見えている幅の中に収まる（測りの丸めの 1px だけ許す）
  expect(menu.right, `${label}：品書きの縁取りが見えている幅の右へはみ出しています（${menuDetail}）`).toBeLessThanOrEqual(bar.visibleRight + 1);
  expect(menu.top, `${label}：品書きが上へはみ出しています（${menuDetail}）`).toBeGreaterThanOrEqual(-1);
  expect(menu.bottom, `${label}：品書きが面の下へはみ出しています（${menuDetail}）`).toBeLessThanOrEqual(bar.frameHeight + 1);
  console.info(`[E2E] ${label}：${menuDetail}`);
  await page.keyboard.press("Escape");
  await waitUntil(async () => !(await menuOpen(frame)), `${label}：Esc で品書きが閉じる`, 5_000);
}

test("窓を幅 400px に狭めても、横書き・縦書きとも上の列のボタンは見えている幅の中に収まり、［校正］の品書きも見えている幅と面の高さからはみ出さない", async () => {
  await withVsCode(
    "［校正］の狭い窓",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const horizontal = await openEpisode(page, EPISODE, "静かだった");
      await resizeWindows(session.app, NARROW);
      const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      console.info(`[E2E] 狭めた窓の中身の大きさ：${JSON.stringify(size)}`);
      expect(size.width, `窓が 400px ほどに狭まりません（${JSON.stringify(size)}）`).toBeLessThanOrEqual(420);

      // 原稿エディターは横書きで開く（見本は .txt。既定の向きが縦なら先に横へ替える）
      const startsVertical = await horizontal.evaluate(() => getComputedStyle(document.getElementById("compose") as HTMLElement).writingMode.startsWith("vertical"));
      if (startsVertical) await horizontal.evaluate(() => (document.getElementById("dir") as HTMLButtonElement).click());
      await waitUntil(
        async () => !(await horizontal.evaluate(() => getComputedStyle(document.getElementById("compose") as HTMLElement).writingMode.startsWith("vertical"))),
        "横書きになる",
        10_000
      );
      await expectFitsNarrow(page, horizontal, "横書き");

      const vertical = await turnVertical(session, "静かだった");
      await expectFitsNarrow(page, vertical, "縦書き");
    },
    { ...VERTICAL_LAUNCH }
  );
}, 240_000);
