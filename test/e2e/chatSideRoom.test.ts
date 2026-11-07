/**
 * 横の相談パネル（AIに相談）を開いたとき、**入力欄と［送る］が枠の中に見える**（画面の自動テスト、設計書6.21・6.113。
 * 作者の裁定「両方直す」、2026-10-16）。
 *
 * 横の相談パネルは左の列の一番下に置かれ、上の3つのビューの残りしか貰えないと枠（WebView）の高さが
 * 約100pxになり、入力欄はその下（窓の外）にあった（`support/chatInput.ts` の説明。chatLocateAndMain が
 * 単独で24回中4回落ちていた原因）。製品は2段で直した：最初に出すときの高さ（package.json の initialSize）と、
 * 低いときに中を詰める CSS（`views/workChatPanelHtml.ts` の `@media (max-height: 200px)`）。
 *
 * 2件目（2026-11-07）は、境目を引いて低く・細くした形を見る（谷の 201〜260px で押し出された Mac の再現）。
 *
 * ここで見るのは形だけ。押したり打ったりはしない（座標で押すと、落ちたときに
 * 高さの問題か押し方の問題かが分からなくなる）。**本物の AI は呼ばない**（相談は送らない）。
 */
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { chatInputState } from "./support/chatInput";
import { openEpisode } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  activeElementSummary,
  dragSash,
  paneHeaderBox,
  pressWorkbenchKey,
  sidebarBox,
  webviewLayers,
} from "./support/workbenchDom";

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
      /*
        Mac（1.141.0）で、15秒待っても枠の中に見えず落ちた（面の中の hasFocus は false。2026-11-07）。
        原因が分からないので直さず、次の1回で読めるように様子を足す：本体の焦点・見えている WebView の枠
        （位置・大きさ・前に出ているか）・窓の大きさ。画面の写真の道は withVsCode が下の行に足す
      */
      const viewport = await page
        .evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
        .catch(() => null);
      throw new Error(
        `${String(error)}（${await chatInputState(frame)}／［送る］：${JSON.stringify(send)}` +
          `／本体の焦点：${await activeElementSummary(page)}／見えている枠：${JSON.stringify(await webviewLayers(page))}` +
          `／窓：${JSON.stringify(viewport)}／${process.platform}）`
      );
    });
    expect(await insideOuter(frame, "#input")).toBe(true);
  }, { keybindings: [{ key: OPEN_SIDE_KEY, command: "novelai.openChat" }] });
});

/** 横の相談パネルの外側の枠（本体から見た iframe）の箱 */
async function outerBox(frame: Frame): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return (
    (await frame
      .parentFrame()
      ?.frameElement()
      .then((element) => element.boundingBox())
      .catch(() => null)) ?? null
  );
}

/**
 * 左の列の境目を引いて、横の相談パネルの枠を `width` 前後の幅・`low`〜`high` の高さにする。
 * 高さは1回で決まらない（上の区画の最小の高さで止まる・木の描き直しで少し動く）ので、測って数回引き直す
 */
async function resizeSideChat(page: Page, frame: Frame, width: number, low: number, high: number): Promise<void> {
  const sidebar = await sidebarBox(page);
  if (!sidebar) throw new Error("左の列が見えません");
  await dragSash(page, "vertical", { x: sidebar.x + sidebar.width, y: sidebar.y + sidebar.height / 2 }, width - sidebar.width);
  for (let attempt = 0; attempt < 5; attempt++) {
    const box = await outerBox(frame);
    if (box && box.height >= low && box.height <= high) return;
    const header = await paneHeaderBox(page, "AIに相談");
    if (!box || !header) break;
    // 相談の区画の見出しの真上の境目を下へ引くと、相談が低くなる
    await dragSash(page, "horizontal", { x: header.x + header.width / 2, y: header.y }, box.height - (low + high) / 2);
    await page.waitForTimeout(300);
  }
  const box = await outerBox(frame);
  throw new Error(`横の相談パネルの枠を高さ ${low}〜${high}px にできません（枠：${JSON.stringify(box)}／左の列：${JSON.stringify(await sidebarBox(page))}）`);
}

/** 面の中で、要素の真ん中を押したときに当たるのがその要素自身か（重なりや枠の外で押せない形を拾う） */
async function hitsItself(frame: Frame, selector: string): Promise<string | undefined> {
  return frame.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return `${sel} が無い`;
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (top && (element === top || element.contains(top))) return undefined;
    return `${sel} の真ん中に当たるのは ${top ? `${top.tagName.toLowerCase()}#${top.id}.${String(top.className)}` : "なし（面の外）"}`;
  }, selector);
}

/**
 * **低く・細くしても、入力欄と［送る］が枠の中に見えて押せる**（2026-11-07）。
 *
 * Mac（1440x795、1.141.0）で、枠の高さ 217px のとき聞き方の例が2段に折れて、入力欄は 2.5px、
 * ［送る］は 44px 枠の外へ押し出された。低いときの詰め方（`@media (max-height: 200px)`）の手前の
 * 201〜260px が手当ての無い谷で、細い枠ほど札とボタンが折れて押し出す。作者の機械でも、
 * パネルを低く・細くすれば起きる。直しは `views/workChatPanelHtml.ts`（縮むのは会話の欄・札の欄・上の行）。
 *
 * 谷の中（205〜235px）と、詰め方の効く 200px 以下（165〜195px）の2つの高さを、幅 200px 前後で見る。
 * **押さない**——押すと送る処理が走る。真ん中で当たるのが［送る］自身であることで「押せる」とみなす。
 * 2026-11-07 に書いた時点では Windows で未実行（作者が使っている機械では流さない）。初めて走るのは Mac
 */
test("横の相談パネルを低く・細くしても、入力欄と［送る］が枠の中に見えて押せる（200px の手前の谷でも）", async () => {
  await withVsCode("相談パネルを低く細く", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page } = session;
    await openEpisode(page, EPISODE, "発車のベルが鳴った");
    await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
    let side: Frame | undefined;
    await waitUntil(async () => (side = await sideChatFrame(page)) !== undefined, "横の相談パネルが開く", 30_000);
    const frame = side as Frame;
    // 聞き方の例が届いて並ぶまで待つ（札が折れて押し出すのを見るので、札が無いまま測らない）
    await waitUntil(
      async () => (await frame.locator("#examples .example").count().catch(() => 0)) >= 3,
      "横の相談パネルに聞き方の例が並ぶ",
      15_000
    );

    for (const [low, high] of [
      [205, 235],
      [165, 195],
    ] as const) {
      await resizeSideChat(page, frame, 200, low, high);
      const box = await outerBox(frame);
      const where = `枠：${JSON.stringify(box)}`;
      // 通ったときも、本当に狙った高さ（谷の中か）に入っていたかを出力に残す
      console.log(`[chatSideRoom] 高さ ${low}〜${high}px の狙いで ${where}`);
      expect(box!.width, `枠の幅が細くなっていない（${where}）`).toBeLessThanOrEqual(240);
      await waitUntil(
        async () => (await insideOuter(frame, "#input")) && (await insideOuter(frame, "#send")),
        `高さ ${low}〜${high}px で、入力欄と［送る］が枠の中に見える`,
        10_000
      ).catch(async (error: unknown) => {
        const send = await frame.locator("#send").boundingBox().catch(() => null);
        throw new Error(`${String(error)}（${where}／${await chatInputState(frame)}／［送る］：${JSON.stringify(send)}／${process.platform}）`);
      });
      const input = await frame.locator("#input").boundingBox();
      // 入力欄が潰れて「枠の中にある」だけにならない（1行ぶんは打てる高さ）
      expect(input!.height, `入力欄が潰れている（${where}／入力欄：${JSON.stringify(input)}）`).toBeGreaterThanOrEqual(24);
      expect(await hitsItself(frame, "#send"), `［送る］が押せない（${where}）`).toBeUndefined();
      expect(await hitsItself(frame, "#input"), `入力欄が押せない（${where}）`).toBeUndefined();
    }
  }, {
    keybindings: [{ key: OPEN_SIDE_KEY, command: "novelai.openChat" }],
    windowSize: { width: 1280, height: 800 },
    // 境目を引いたあと矢印が区画の見出しの上に残り、吹き出しが次の引き直しに重ならないよう、吹き出しを出さない
    settings: { "workbench.hover.delay": 600_000 },
  });
});
