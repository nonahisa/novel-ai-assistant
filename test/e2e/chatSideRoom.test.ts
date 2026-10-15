/**
 * 横の相談パネル（AIに相談）を開いたとき、**入力欄と［送る］が枠の中に見える**（画面の自動テスト、設計書6.21・6.113。
 * 作者の裁定「両方直す」、2026-10-16）。
 *
 * 横の相談パネルは左の列の一番下に置かれ、上の3つのビューの残りしか貰えないと枠（WebView）の高さが
 * 約100pxになり、入力欄はその下（窓の外）にあった（`support/chatInput.ts` の説明。chatLocateAndMain が
 * 単独で24回中4回落ちていた原因）。製品は2段で直した：最初に出すときの高さ（package.json の initialSize）と、
 * 低いときに中を詰める CSS（`views/workChatPanelHtml.ts` の `@media (max-height: 200px)`）。
 *
 * ここで見るのは「開いた直後の形」だけ。押したり打ったりはしない（座標で押すと、落ちたときに
 * 高さの問題か押し方の問題かが分からなくなる）。**本物の AI は呼ばない**（相談は送らない）。
 */
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { chatInputState } from "./support/chatInput";
import { openEpisode } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const BODY = ["　朝の駅は静かだった。", "　発車のベルが鳴った。", ""].join("\n");
/**
 * 横の相談パネルを開くキー。**製品の割り当てではない**——使い捨ての keybindings.json に
 * `novelai.openChat` を割り当てて押す（chatLocateAndMain と同じ。割り当てを渡し忘れると何も開かない）
 */
const OPEN_SIDE_KEY = "ctrl+alt+shift+c";
const OPEN_SIDE_PRESS = "Control+Alt+Shift+KeyC";

/** 横の相談パネルの面（`#context-what` と `#to-main` を持つ） */
async function sideChatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const side = await frame
      .evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null)
      .catch(() => false);
    if (side) return frame;
  }
  return undefined;
}

/** 面の中の要素が、外側の枠（本体から見た iframe）の中に収まっているか */
async function insideOuter(frame: Frame, selector: string): Promise<boolean> {
  const outer = await frame
    .parentFrame()
    ?.frameElement()
    .then((element) => element.boundingBox())
    .catch(() => null);
  const box = await frame.locator(selector).boundingBox().catch(() => null);
  if (!outer || !box || box.height <= 0) return false;
  return box.y >= outer.y - 1 && box.y + box.height <= outer.y + outer.height + 1;
}

test("横の相談パネルを開くと、入力欄と［送る］が枠の中に見える（約100pxに縮んでも外へ押し出されない）", async () => {
  await withVsCode("相談パネルの高さ", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page } = session;
    // 原稿を開いてから相談を開く（作者のふだんの順。chatLocateAndMain と同じ）
    await openEpisode(page, EPISODE, "発車のベルが鳴った");
    await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
    let side: Frame | undefined;
    await waitUntil(async () => (side = await sideChatFrame(page)) !== undefined, "横の相談パネルが開く", 30_000);
    const frame = side as Frame;

    // 左の列の木の高さは開いた直後にまだ動くので、収まった形になるまで待つ（落ちたら枠と入力欄の箱を添える）
    await waitUntil(
      async () => (await insideOuter(frame, "#input")) && (await insideOuter(frame, "#send")),
      "入力欄と［送る］が横の相談パネルの枠の中に見える",
      15_000
    ).catch(async (error: unknown) => {
      const send = await frame.locator("#send").boundingBox().catch(() => null);
      throw new Error(`${String(error)}（${await chatInputState(frame)}／［送る］：${JSON.stringify(send)}）`);
    });
    expect(await insideOuter(frame, "#input")).toBe(true);
  }, { keybindings: [{ key: OPEN_SIDE_KEY, command: "novelai.openChat" }] });
});
