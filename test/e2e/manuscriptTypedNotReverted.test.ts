/**
 * 打った直後に面が入れ替わっても、打った字が一瞬も消えない（画面の自動テスト、
 * 設計書6.25.9・6.113。2026-11-02）。
 *
 * manuscriptTermsEol の揺れを調べて見つかった。字を打った直後に面を押して前へ出す・
 * 後ろへ回すと、本体は面の出入り（onDidChangeViewState）で本文を送り直す。その本文を
 * 読んだのが打った字の便を当てる前だと、画面には打つ前の本文が届き、画面はそれで
 * 描き直して、打った字が0.13〜0.2秒消えてから戻った。
 *
 * 揺れに頼らず毎回その順を作るため、片方の面の「打った字の便」だけを外側の枠で
 * 0.4秒遅らせる（`delayEditsToHost`。製品には何も足さない）。その間に別の面を押すと、
 * 本体は必ず打つ前の本文を送ってくる。
 *
 * 何を見張るか：
 * - 面の中の字の移り変わり（`startComposeTrace`）で、**一度出た字が後で消えない**
 * - その0.4秒の間に続けて打っても、**字が失われず、打った順・打った場所に入る**
 *   （カーソルがずれない）。控えの帯（重なって入らなかった字）も出ない
 *
 * **作者の原稿は使わない。AI は呼ばない。**
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import {
  classOpen,
  composeText,
  composeTrace,
  delayEditsToHost,
  manuscriptFrames,
  openEpisode,
  placeCaretAfter,
  startComposeTrace,
} from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_打った字.md";
const MARKER = "朝の駅は静かだった。";
const TEXT = `　${MARKER}\n　改札を抜けて、白い息を吐いた。\n`;
/** 打った字の便を遅らせる長さ（本体の送り直し 120ミリ秒より長く、見回り 4秒より十分短く） */
const EDIT_DELAY_MS = 400;
/**
 * 続けて打つ件で遅らせる長さ。本体が古い本文を送ってくるのは、面を押してから0.3秒ほど
 * あと（面の出入りの知らせが遅れて来る）。その知らせを受けてから続けて打ち終えるまで、
 * 1字目の便を本体へ着かせない
 */
const LONG_EDIT_DELAY_MS = 1500;

const SPLIT_KEY = "ctrl+alt+shift+o";
const SPLIT_PRESS = "Control+Alt+Shift+KeyO";

async function readEpisode(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

/** 右へ分割して、同じ話の2枚目を作る。[左, 右] を返す（右が前に出ている） */
async function openTwoFaces(page: Page): Promise<[Frame, Frame]> {
  const first = await openEpisode(page, EPISODE, "改札を抜けて");
  await pressWorkbenchKey(page, SPLIT_PRESS);
  let second: Frame | undefined;
  await waitUntil(
    async () => {
      const frames = await manuscriptFrames(page);
      second = frames.find((frame) => frame !== first);
      return second !== undefined && (await composeText(second).catch(() => "")).includes("改札を抜けて");
    },
    "同じ話の2枚目が開いて本文が出る",
    20_000
  );
  return [first, second as Frame];
}

/**
 * 記録の中で、一度出た字（`tokens` のどれか）が後の記録で消えた瞬間を返す（無ければ空）。
 * 消えたら、その前後の記録を添える（何ミリ秒消えていたか読めるように）
 */
function vanished(trace: Array<{ t: number; text: string }>, tokens: string[]): string[] {
  const found: string[] = [];
  for (const token of tokens) {
    const firstSeen = trace.findIndex((entry) => entry.text.includes(token));
    if (firstSeen < 0) continue;
    const lost = trace.findIndex((entry, index) => index > firstSeen && !entry.text.includes(token));
    if (lost < 0) continue;
    const back = trace.findIndex((entry, index) => index > lost && entry.text.includes(token));
    found.push(
      `「${token}」が +${trace[lost].t - trace[firstSeen].t}ms に消え、` +
        (back < 0 ? "戻らなかった" : `+${trace[back].t - trace[firstSeen].t}ms に戻った`) +
        `（消えた時の本文：${JSON.stringify(trace[lost].text.slice(0, 80))}）`
    );
  }
  return found;
}

async function settleInFile(
  session: E2ESession,
  page: Page,
  expected: string,
  label: string,
  delayMs = EDIT_DELAY_MS
): Promise<void> {
  // 遅らせた便が本体へ着いて当たるのを待ってから保存する（先に保存すると、
  // あとから当たった字は未保存のまま残り、ファイルを待っても入らない）
  await page.waitForTimeout(delayMs + 800);
  await page.keyboard.press("Control+KeyS");
  await waitUntil(async () => (await readEpisode(session)).includes(expected), label).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（ファイル：${JSON.stringify(await readEpisode(session))}）`);
  });
}

test("打った直後に別の面を押しても、打った字が一瞬も消えない", async () => {
  await withVsCode(
    "打った字が消えない",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const [left, right] = await openTwoFaces(page);
      await delayEditsToHost(left, EDIT_DELAY_MS);

      // 左を押して前へ出す（ここで出る送り直しは、打つ前に落ち着かせる）
      await placeCaretAfter(left, MARKER);
      await page.waitForTimeout(500);
      await startComposeTrace(left);

      await page.keyboard.insertText("【一】");
      // 打った字の便が本体へ着く前に、右の面を押す（左は後ろへ回り、本体が本文を送り直す）
      await right.locator("#compose").click();

      await settleInFile(session, page, `${MARKER}【一】`, "打った字がファイルに入る");
      await waitUntil(async () => (await composeText(left)).includes(`${MARKER}【一】`), "左の面に打った字がある");
      const lost = vanished(await composeTrace(left), ["【一】"]);
      expect(lost, `打った字が古い本文で消えた：${lost.join("／")}`).toEqual([]);
      expect(await classOpen(left, "rescue"), "控えの帯が出ていない").toBe(false);
    },
    { keybindings: [{ key: SPLIT_KEY, command: "workbench.action.splitEditorRight" }] }
  );
}, 180_000);

test("面を押し直して0.2秒のうちに続けて打っても、字が失われずカーソルもずれない", async () => {
  await withVsCode(
    "続けて打つ",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const [left, right] = await openTwoFaces(page);
      await delayEditsToHost(left, LONG_EDIT_DELAY_MS);

      await placeCaretAfter(left, MARKER);
      await page.waitForTimeout(500);
      await startComposeTrace(left);

      // 1字目 → 右を押す（左が後ろへ回り、本体が打つ前の本文を送ってくる）→ 0.5秒待つ
      // → 左へ戻って同じ所の直後に、0.2秒のうちに続けて2回打つ。
      // ここまで全部、1字目の便が本体へ着く前（1.5秒）に済ませる
      await page.keyboard.insertText("【一】");
      await right.locator("#compose").click();
      await page.waitForTimeout(500);
      await placeCaretAfter(left, MARKER);
      await page.keyboard.insertText("【二】");
      await page.waitForTimeout(50);
      await page.keyboard.insertText("【三】");

      // 2・3字目は1字目の前（カーソルを置いた MARKER の直後）に、打った順で入る
      const expected = `${MARKER}【二】【三】【一】`;
      await settleInFile(session, page, expected, "続けて打った字が打った順にファイルに入る", LONG_EDIT_DELAY_MS);
      await waitUntil(async () => (await composeText(left)).includes(expected), "左の面に打った順で出る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（左の面：${JSON.stringify(await composeText(left))}）`);
        }
      );
      const lost = vanished(await composeTrace(left), ["【一】", "【二】", "【三】"]);
      expect(lost, `打った字が古い本文で消えた：${lost.join("／")}`).toEqual([]);
      expect(await classOpen(left, "rescue"), "控えの帯が出ていない").toBe(false);

      // カーソルは最後に打った字の直後に残っている（描き直しで動いていない）
      await page.keyboard.insertText("【四】");
      await settleInFile(session, page, `${MARKER}【二】【三】【四】【一】`, "続けて打った字がカーソルの位置に入る", LONG_EDIT_DELAY_MS);
    },
    { keybindings: [{ key: SPLIT_KEY, command: "workbench.action.splitEditorRight" }] }
  );
}, 180_000);
