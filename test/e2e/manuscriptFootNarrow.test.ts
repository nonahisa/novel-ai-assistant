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
import { clearNotifications } from "./support/workbenchDom";

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
      await page.keyboard.press(OPEN_PROPOSALS_PRESS);
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
