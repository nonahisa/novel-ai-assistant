/**
 * 原稿エディターを狭くしたとき、本文の面（組んで書く面・打つ面）の右端の字が窓の外へ
 * 隠れない（画面の自動テスト、設計書6.25・6.11.7・6.113。作者の裁定 2026-10-09）。
 *
 * 原因は提案パネル・原稿エディターの下の段（`manuscriptFootNarrow.test.ts`）と同じ：
 * VS Code の編集の列には最小幅 220px があり、窓が狭いと右の列の端が窓の外へ出る。
 * WebView の中からは自分の幅が 220px に見えるので、本文はその幅で折り返し、
 * **見えている幅より右の字が窓の外に隠れていた。** 縦書き（vertical-rl）は右端から
 * 書き始めるので、**1行目の頭そのものが窓の外に出る。**
 *
 * 確かめること：
 * - 横書き・縦書きとも、狭い窓で本文の字のどれも見える幅の右へはみ出さない
 *   （縦書きでは、本文の最初の字が見える幅の中にある）
 * - 広い窓では、本文の面の幅に手を付けない（`#surface` の最大幅が空のまま）
 * - 狭い⇔広いを行き来しても、カーソルの位置（どの行の何字目か）が変わらず、
 *   カーソルが見えている所に残る
 *
 * **AI は呼ばない。** 見本の話だけを使う。
 */
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { caretPosition, footText, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  writeSampleFinding,
} from "./support/sampleFinding";
import { resizeWindows, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { activeGroupIndex, clearNotifications, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const SECOND = "002_つづき.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　ホームの時計が、零時を指していた。", ""].join("\n");

/** 狭い窓でも広い窓でも折り返す長さの行を積む（縦書きでは左へ溢れて転がる量になる） */
const CARET_LINE = "　二十行目、ここで傘を置き忘れたことに気づいた。";
const SECOND_TEXT = [
  "　二話目の本文。改札を出ると、雨はもう霧のように細かくなっていて、街灯の明かりがにじんでいた。",
  ...Array.from({ length: 18 }, (_, index) => `　${index + 2}行目、濡れた舗道に足音だけが返ってくる夜だった。`),
  CARET_LINE,
  ...Array.from({ length: 20 }, (_, index) => `　${index + 21}行目、駅前の古い喫茶店はとうに灯りを落としていた。`),
  "",
].join("\n");

/**
 * 窓の幅。640px（下の段のテストの幅）では列の切れが20px足らずで、本文の面の余白（約25px）に
 * 隠れて字は切れない。字が切れるほど列が外へ出る幅にする（手元で、見える幅は約120px）
 */
const NARROW = { width: 560, height: 800 };
const WIDE = { width: 1600, height: 900 };

interface Measure {
  /** 原稿エディターの列が窓の中で実際に見えている幅（本体の側で測る） */
  width: number;
  /** 面自身が思っている幅（WebView の中の幅） */
  frameWidth: number;
  /** 本文の面（#surface）の右端 */
  surfaceRight: number;
  /** 見える幅の右へはみ出した本文の字の箱（数と、最初の1つ） */
  overflowCount: number;
  overflowSample: string;
  /** 本文の最初の字の箱の右端・左端 */
  headRight: number;
  headLeft: number;
  /** 本文の面に詰めた最大幅（空なら詰めていない） */
  surfaceMaxWidth: string;
  vertical: boolean;
}

/** いま前に出ている列（原稿エディターを開いた列）が、窓の中で見えている幅 */
async function visibleWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const active = document.querySelector(".editor-group-container.active") ?? document.querySelector(".editor-group-container");
    if (!active) return 0;
    const box = active.getBoundingClientRect();
    return Math.min(box.width, window.innerWidth - box.left);
  });
}

async function measure(page: Page, frame: Frame): Promise<Measure> {
  const width = await visibleWidth(page);
  const inside = await frame.evaluate((visible) => {
    const surface = document.getElementById("surface") as HTMLElement;
    const compose = document.getElementById("compose") as HTMLElement;
    let overflowCount = 0;
    let overflowSample = "";
    let headRight = -1;
    let headLeft = -1;
    // 本文の面の中で転がって見えなくなった字（縦書きで右へ送った行など）は数えない。
    // 数えるのは、面の中にあるのに窓の外へ出ている字だけ
    const faceBox = compose.getBoundingClientRect();
    const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (text.trim() === "") continue;
      if (headRight < 0) {
        // 字下げの全角空白を飛ばした、本文の最初の字
        const at = text.search(/[^\s　]/);
        const head = document.createRange();
        head.setStart(node, at);
        head.setEnd(node, at + 1);
        const rect = head.getBoundingClientRect();
        headRight = rect.right;
        headLeft = rect.left;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 && rect.height === 0) continue;
        // 窓に隠れる帯＝見える幅の右端から面の右端まで。面の縁で面自身に切られている字
        // （転がしの途中の行）は面のふつうの見え方なので数えない
        if (faceBox.right <= visible + 1) continue;
        if (rect.left >= faceBox.right - 1 || rect.right <= faceBox.left) continue;
        if (rect.right > visible + 1) {
          overflowCount++;
          if (!overflowSample) overflowSample = `「${text.slice(0, 10)}」右端${Math.round(rect.right)}`;
        }
      }
    }
    return {
      frameWidth: document.documentElement.clientWidth,
      surfaceRight: surface.getBoundingClientRect().right,
      overflowCount,
      overflowSample,
      headRight,
      headLeft,
      surfaceMaxWidth: surface.style.maxWidth,
      vertical: getComputedStyle(compose).writingMode.startsWith("vertical"),
    };
  }, width);
  return { width, ...inside };
}

/** 向きを揃える（帯の［縦書きにする／横書きにする］を押す） */
async function setVertical(frame: Frame, wanted: boolean): Promise<void> {
  const now = await frame.evaluate(() => getComputedStyle(document.getElementById("compose") as HTMLElement).writingMode);
  if (now.startsWith("vertical") === wanted) return;
  await frame.evaluate(() => (document.getElementById("dir") as HTMLButtonElement).click());
  await waitUntil(
    async () =>
      (await frame.evaluate(() => getComputedStyle(document.getElementById("compose") as HTMLElement).writingMode)).startsWith(
        "vertical"
      ) === wanted,
    wanted ? "縦書きになる" : "横書きになる",
    10_000
  );
}

/** カーソルが本文の面のうち、窓の中に見えている所にあるか */
async function caretInView(frame: Frame, visible: number): Promise<boolean> {
  return frame.evaluate((visibleWidth) => {
    const selection = window.getSelection();
    const compose = document.getElementById("compose");
    if (!selection || selection.rangeCount === 0 || !compose) return false;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const box = compose.getBoundingClientRect();
    const right = Math.min(box.right, visibleWidth);
    return rect.left >= box.left - 1 && rect.right <= right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
  }, visible);
}

/** 落ちたときに読む：カーソルの箱・面の箱・転がり具合 */
async function caretDetail(frame: Frame, visible: number): Promise<string> {
  const inside = await frame.evaluate(() => {
    const selection = window.getSelection();
    const compose = document.getElementById("compose") as HTMLElement;
    const rect = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : undefined;
    const box = compose.getBoundingClientRect();
    const round = (value: number) => Math.round(value);
    return JSON.stringify({
      caret: rect ? [rect.left, rect.top, rect.right, rect.bottom].map(round) : null,
      face: [box.left, box.top, box.right, box.bottom].map(round),
      scroll: [round(compose.scrollLeft), round(compose.scrollTop)],
      maxWidth: (document.getElementById("surface") as HTMLElement).style.maxWidth,
    });
  });
  return `見える幅 ${visible}px ${inside}`;
}

/** カーソルが見えるまで待つ。見えなければ、箱の数字を添えて落とす */
async function waitCaretInView(page: Page, frame: Frame, label: string): Promise<void> {
  try {
    await waitUntil(async () => caretInView(frame, await visibleWidth(page)), label, 5_000);
  } catch (error) {
    throw new Error(`${(error as Error).message}（${await caretDetail(frame, await visibleWidth(page))}）`);
  }
}

/** カーソルが見えている所まで本文を転がす（見えている幅で測る） */
async function scrollCaretIntoView(frame: Frame, visible: number): Promise<void> {
  await frame.evaluate((visibleWidth) => {
    const selection = window.getSelection();
    const compose = document.getElementById("compose") as HTMLElement;
    if (!selection || selection.rangeCount === 0) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const box = compose.getBoundingClientRect();
    const right = Math.min(box.right, visibleWidth);
    if (rect.right > right - 30) compose.scrollLeft += rect.right - right + 60;
    else if (rect.left < box.left + 30) compose.scrollLeft -= box.left - rect.left + 60;
    if (rect.bottom > box.bottom - 30) compose.scrollTop += rect.bottom - box.bottom + 60;
    else if (rect.top < box.top + 30) compose.scrollTop -= box.top - rect.top + 60;
  }, visible);
}

/**
 * 写真と同じ並びにする：1話目を開いてから提案パネルを右の列へ開き、2話目をその右の列で開く
 * （右の列が窓の外へ出て切られる。1列だけでは列が窓に収まるので切れない）
 */
async function openClipped(session: E2ESession): Promise<Frame> {
  const { page } = session;
  await writeSampleFinding(session.workFolder, {
    episode: EPISODE,
    text: TEXT,
    original: "零時を指していた。",
    target: "零時",
    suggestion: "零時半",
    message: "見本",
  });
  await openEpisode(page, EPISODE, "零時を指していた");
  await clearNotifications(page);
  await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
  await waitUntil(async () => (await proposalPanelFrame(page)) !== undefined, "提案パネルが開く", 15_000);
  // 2話目は提案パネルの列（右の列）で開く。列が2つ並び、焦点が右の列に移るまで待つ
  await waitUntil(async () => (await activeGroupIndex(page)) === 1, "提案パネルの列に焦点が移る", 15_000);
  // 提案パネル（WebView）に焦点が移ると、クイックオープンの Ctrl+P が本体へ届かないことがある
  // （このファイルを続けて回して3回に1回ほど落ちた。pressWorkbenchKey の注釈と同じ事情）。
  // 焦点を本体へ戻してから開く
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active && active.tagName === "IFRAME") (active as HTMLElement).blur();
    window.focus();
  });
  const frame = await openEpisode(page, SECOND, "二話目の本文");
  expect(await activeGroupIndex(page), "2話目が右の列で開いていません").toBe(1);
  await waitUntil(async () => (await footText(frame, "counts")).includes("このファイル"), "下段に字数が出る", 15_000);
  return frame;
}

/** 本文の字が、見えている幅に収まるまで待って、最後に測ったものを返す */
async function measureFitted(page: Page, frame: Frame): Promise<Measure> {
  let last: Measure | undefined;
  await waitUntil(
    async () => {
      last = await measure(page, frame);
      return last.width > 0 && last.overflowCount === 0 && last.surfaceRight <= last.width + 1;
    },
    "本文が、窓の中で見えている幅に収まる",
    10_000
  ).catch(() => undefined);
  return last as Measure;
}

function describe(result: Measure): string {
  return `見える幅 ${result.width}px／面の幅 ${result.frameWidth}px／本文の面の右端 ${Math.round(result.surfaceRight)}px／はみ出し ${result.overflowCount}（${result.overflowSample}）／最初の字 ${Math.round(result.headLeft)}〜${Math.round(result.headRight)}px`;
}

const EPISODES = [
  { name: EPISODE, text: TEXT },
  { name: SECOND, text: SECOND_TEXT },
];

for (const vertical of [false, true]) {
  const label = vertical ? "縦書き" : "横書き";
  test(`狭い窓で、${label}の本文の右端が窓の外へ隠れない`, async () => {
    await withVsCode(
      `本文・狭い・${label}`,
      EPISODES,
      async (session) => {
        const { page } = session;
        const frame = await openClipped(session);
        await setVertical(frame, vertical);
        const result = await measureFitted(page, frame);
        const detail = describe(result);

        // 写真と同じ形：列の右端が窓の外へ出て、見える幅が面の幅より狭い
        expect(result.width, `写真と同じ形になっていません（${detail}）`).toBeLessThan(result.frameWidth);
        expect(result.vertical, `向きが違います（${detail}）`).toBe(vertical);
        expect(result.surfaceRight, `本文の面が見える幅の右へはみ出しています（${detail}）`).toBeLessThanOrEqual(result.width + 1);
        expect(result.overflowCount, `見える幅の右へはみ出した字があります（${detail}）`).toBe(0);
        // 縦書きは右端から書き始める。最初の字（1行目の頭）が見える幅の中にあること
        expect(result.headRight, `本文の最初の字が窓の外にあります（${detail}）`).toBeLessThanOrEqual(result.width + 1);
        expect(result.headLeft, `本文の最初の字が測れません（${detail}）`).toBeGreaterThanOrEqual(0);
      },
      { ...OPEN_PROPOSALS_LAUNCH, windowSize: NARROW }
    );
  });
}

test("広い窓では、本文の面の幅に手を付けない", async () => {
  await withVsCode(
    "本文・広い",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await waitUntil(async () => (await footText(frame, "counts")).includes("このファイル"), "下段に字数が出る", 15_000);
      for (const vertical of [false, true]) {
        await setVertical(frame, vertical);
        const result = await measure(page, frame);
        expect(result.width, "列が広くなっていません").toBeGreaterThan(420);
        expect(result.overflowCount, describe(result)).toBe(0);
        // 切れていないときは、本文の面の幅に手を付けない（広いときの見た目を変えない）
        expect(result.surfaceMaxWidth).toBe("");
      }
    },
    { windowSize: WIDE }
  );
});

for (const vertical of [false, true]) {
  const label = vertical ? "縦書き" : "横書き";
  test(`${label}で狭い窓と広い窓を行き来しても、カーソルの位置と見えている場所が飛ばない`, async () => {
    await withVsCode(
      `本文・行き来・${label}`,
      EPISODES,
      async (session) => {
        const { page, app } = session;
        const frame = await openClipped(session);
        await setVertical(frame, vertical);
        await measureFitted(page, frame);

        await placeCaretAfter(frame, "傘を置き");
        await scrollCaretIntoView(frame, await visibleWidth(page));
        const before = await caretPosition(frame);
        expect(before?.lineText ?? "").toContain("傘を置き忘れた");
        expect(await caretInView(frame, await visibleWidth(page)), "最初にカーソルが見えていません").toBe(true);

        // 広げる：詰めた幅を外し、カーソルは同じ字の所で見えたまま。
        // 窓の高さも変える（縦書きは高さで行の折り返しが変わり、カーソルの列が動く）
        await resizeWindows(app, WIDE);
        await waitUntil(async () => (await measure(page, frame)).surfaceMaxWidth === "", "広げたら本文の幅を詰めなくなる", 10_000);
        await waitCaretInView(page, frame, "広げたあともカーソルが見えている");
        expect(await caretPosition(frame), "広げたらカーソルの位置が変わりました").toEqual(before);

        // 狭める：すぐに戻す。また見えている幅に詰め、カーソルは同じ字の所で見えたまま
        await resizeWindows(app, NARROW);
        const narrowed = await measureFitted(page, frame);
        expect(narrowed.surfaceRight, describe(narrowed)).toBeLessThanOrEqual(narrowed.width + 1);
        expect(narrowed.overflowCount, describe(narrowed)).toBe(0);
        await waitCaretInView(page, frame, "狭めたあともカーソルが見えている");
        expect(await caretPosition(frame), "狭めたらカーソルの位置が変わりました").toEqual(before);
      },
      { ...OPEN_PROPOSALS_LAUNCH, windowSize: NARROW }
    );
  });
}
