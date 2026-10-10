/**
 * 原稿エディターを狭くしたとき、下の段（ボタンの段と字数の段）の文が右で切れずに折り返す
 * （画面の自動テスト、設計書6.25・6.11.7・6.113）。
 *
 * 実機確認リスト 4544 行の写真（2026-10-09）：窓を狭くすると、真ん中の列の下に
 * 「作品 93字／このファイル 93字／この…」と出て、右で切れていた。提案パネルと同じ原因
 * （VS Code の編集の列の最小幅 220px のせいで、列の右端が窓の外へ出る）。作者の裁定
 * （2026-10-09）：**狭いときは折り返して全部読めるようにする。広いときの見た目は変えない。**
 *
 * 確かめること：
 * - 狭い窓で、下の段の字数の文・ボタンのどれも、見える幅の右へはみ出さない
 * - 広い窓では、何も詰めない（下の段の最大幅が空のまま）
 *
 * **AI は呼ばない。** 見本の話だけを使う。
 */
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { footText, openEpisode } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  writeSampleFinding,
} from "./support/sampleFinding";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const SECOND = "002_つづき.txt";
const TEXT =["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　ホームの時計が、零時を指していた。", ""].join("\n");

interface Measure {
  /** 原稿エディターの列が窓の中で実際に見えている幅（本体の側で測る） */
  width: number;
  /** 面自身が思っている幅（WebView の中の幅） */
  frameWidth: number;
  /** 見える幅の右へはみ出した要素 */
  overflowing: string[];
  /** 下の段に詰めた最大幅（空なら詰めていない） */
  footMaxWidth: string;
  bottomMaxWidth: string;
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
    const overflowing: string[] = [];
    document.querySelectorAll("#bottom > *, #foot > *").forEach((element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      if (box.right > visible + 1) {
        overflowing.push(`${element.tagName.toLowerCase()}#${element.id}「${(element.textContent ?? "").slice(0, 12)}」右端${Math.round(box.right)}`);
      }
    });
    const foot = document.getElementById("foot") as HTMLElement;
    const bottom = document.getElementById("bottom") as HTMLElement;
    return {
      frameWidth: document.documentElement.clientWidth,
      overflowing,
      footMaxWidth: foot.style.maxWidth,
      bottomMaxWidth: bottom.style.maxWidth,
    };
  }, width);
  return { width, ...inside };
}

test("狭い窓で、原稿エディターの下の段は右で切れずに折り返す", async () => {
  await withVsCode(
    "下の段・狭い",
    [
      { name: EPISODE, text: TEXT },
      { name: SECOND, text: "二話目の本文。\n" },
    ],
    async (session) => {
      const { page } = session;
      // 写真と同じ並びにする：1話目を開いてから提案パネルを右の列へ開き、2話目をその右の列で開く
      // （右の列が窓の外へ出て切られる。1列だけでは列が窓に収まるので切れない）
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
      // 原稿エディター（WebView）を開いた直後は焦点が iframe の中にあり、素のキーは本体へ届かない
      // ことがある（ノートPC、2026-10-10 にこの件が時間切れで落ちた。ほかの件と同じ押し方にそろえる）
      await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
      await waitUntil(async () => (await proposalPanelFrame(page)) !== undefined, "提案パネルが開く", 15_000);
      const frame = await openEpisode(page, SECOND, "二話目の本文");
      await waitUntil(async () => (await footText(frame, "counts")).includes("このファイル"), "下段に字数が出る", 15_000);

      let last: Measure | undefined;
      await waitUntil(
        async () => {
          last = await measure(page, frame);
          return last.width > 0 && last.overflowing.length === 0;
        },
        "下の段が、窓の中で見えている幅に収まる",
        10_000
      ).catch(() => undefined);
      const result = last as Measure;
      const detail = `見える幅 ${result.width}px／面の幅 ${result.frameWidth}px`;

      // 写真と同じ形：列の右端が窓の外へ出て、見える幅が面の幅より狭い
      expect(result.width, `写真と同じ形になっていません（${detail}）`).toBeLessThan(result.frameWidth);
      expect(result.overflowing, `見える幅の右へはみ出した要素があります（${detail}）`).toEqual([]);
    },
    { ...OPEN_PROPOSALS_LAUNCH, windowSize: { width: 640, height: 800 } }
  );
});

/**
 * 列が窓の外へ出ていなくても、列そのものが狭ければ字数の行を「／」で折り返す
 * （作者の実機、2026-10-10。0.101.11）。
 *
 * 左の列を約190pxまで狭めると、ボタンの段は折り返したのに、字数の行だけ
 * 「作品 17,841字 ／ このファイル 5,563字 ／ この話…」と右で切れていた。0.100.6 の直しは
 * 列が窓の外へ出たとき（body.clipped）だけ折り返しを許していたため。
 *
 * 列の幅を190pxへ縮める操作（境目のドラッグ）は VS Code の版で動きが変わるので、
 * ここでは**下の欄の幅だけを190pxに絞って**、本物の Chromium の組版で字数の行が
 * 欄に収まるか・区切りの塊の中で切れていないかを測る（窓の外へは出ないので clipped は付かない）。
 */
test("列そのものが狭いときも、字数の行は「／」の区切りで折り返して欄に収まる", async () => {
  await withVsCode(
    "下の段・列が狭い",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await waitUntil(async () => (await footText(frame, "counts")).includes("このファイル"), "下段に字数が出る", 15_000);

      const wide = await frame.evaluate(() => {
        const pieces = Array.from(document.querySelectorAll("#counts > span"));
        return { tops: [...new Set(pieces.map((piece) => Math.round(piece.getBoundingClientRect().top)))].length, count: pieces.length };
      });
      // 広いときは今までどおり1行（塊がすべて同じ高さに並ぶ）
      expect(wide.count, "字数が区切りの塊に分かれていません").toBeGreaterThanOrEqual(3);
      expect(wide.tops, "広い列なのに字数の行が折り返しています").toBe(1);

      const narrow = await frame.evaluate(() => {
        const foot = document.getElementById("foot") as HTMLElement;
        foot.style.width = "190px";
        foot.style.maxWidth = "190px";
        const right = foot.getBoundingClientRect().right;
        const pieces = Array.from(document.querySelectorAll("#counts > span")) as HTMLElement[];
        return {
          clipped: document.body.classList.contains("clipped"),
          rows: [...new Set(pieces.map((piece) => Math.round(piece.getBoundingClientRect().top)))].length,
          overflowing: pieces
            .filter((piece) => piece.getBoundingClientRect().right > right + 1)
            .map((piece) => `${piece.textContent ?? ""}（右端${Math.round(piece.getBoundingClientRect().right)}／欄${Math.round(right)}）`),
          // 塊の中で行が分かれた（＝数字の途中などで切れた）もの
          split: pieces.filter((piece) => piece.getClientRects().length > 1 || piece.getBoundingClientRect().height > 30).map((piece) => piece.textContent ?? ""),
        };
      });
      expect(narrow.clipped, "列は窓の外へ出ていないはず（clipped が付いています）").toBe(false);
      expect(narrow.overflowing, "字数の行が欄の右へはみ出しています").toEqual([]);
      expect(narrow.rows, "狭い欄なのに字数の行が折り返していません").toBeGreaterThan(1);
      expect(narrow.split, "区切りの塊の中で行が分かれています").toEqual([]);
      // 文字そのものは今までと同じ（「 ／ 」でつないだ形）
      expect(await footText(frame, "counts")).toMatch(/このファイル [\d,]+字 ／ /);
    },
    { windowSize: { width: 1600, height: 900 } }
  );
});

test("広い窓では、原稿エディターの下の段に手を付けない", async () => {
  await withVsCode(
    "下の段・広い",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await waitUntil(async () => (await footText(frame, "counts")).includes("このファイル"), "下段に字数が出る", 15_000);
      const result = await measure(page, frame);

      expect(result.width, "列が広くなっていません").toBeGreaterThan(420);
      expect(result.overflowing).toEqual([]);
      // 切れていないときは、下の段の幅に手を付けない（広いときの見た目を変えない）
      expect(result.footMaxWidth).toBe("");
      expect(result.bottomMaxWidth).toBe("");
    },
    { windowSize: { width: 1600, height: 900 } }
  );
});
