/**
 * 執筆統計の日ごとのグラフ（画面の自動テスト、設計書6.3・6.113）。
 *
 * 実機確認リスト 0.76.5〜0.83.13 の節の項目を機械へ移したもの（2026-10-04）：
 * - 「目標 ○」の札が、縦軸の数字・棒と重ならず、収まらないときは棒の並びの外（右）へ出る
 * - 開いたとき、日ごとのグラフが**右端（今日の側）から**見えている。左へ送ったあとは、描き直しで
 *   引き戻されない。「話ごとの文字数」から戻ったとき・日次⇔週次を切り替えたときは右端から見える
 *
 * 描かれた SVG の矩形（`getBoundingClientRect`）で見る。**色や読みやすさの良し悪しは見ていない。**
 * 日ごとの記録は製品が読む形で置く。**AI は呼ばない。** 横送りが要る幅にするため、窓を狭くする。
 */
import { expect, test } from "vitest";
import type { Frame, Page } from "playwright-core";
import { runCommand, waitForQuickInput } from "./support/quickInput";
import { chartBoxes, chartScroll, statsFrame, writeStatsFile, type SampleDay } from "./support/statsFixture";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pickQuickPickRow } from "./support/workbenchDom";

/** 「作品の種類」で種類を替える（コマンドパレット→選ぶ画面。作者の道順） */
async function setWorkKind(page: Page, label: string): Promise<void> {
  await runCommand(page, "作品の種類（小説・台本など）");
  await waitForQuickInput(page, "の種類");
  await pickQuickPickRow(page, label);
}

const EPISODE = { name: "001_はじまり.txt", text: "一行目の文。\n" };

/** 30日ぶん、どの日も目標（10字）に届かない記録（目標の線がいちばん上になり、数字と重なる形） */
function belowGoalDays(): SampleDay[] {
  return Array.from({ length: 30 }, (_, index) => ({ offset: index - 29, net: 3 + (index % 6) }));
}

async function openStats(session: E2ESession): Promise<Frame> {
  await runCommand(session.page, "執筆統計");
  let frame: Frame | undefined;
  await waitUntil(async () => (frame = await statsFrame(session.page)) !== undefined, "執筆統計の画面が開く", 30_000);
  if (!frame) throw new Error("執筆統計の面が見つかりません");
  const found = frame;
  await waitUntil(async () => (await found.locator("#chart rect.bar").count()) >= 30, "日ごとの棒が描かれる", 20_000);
  return found;
}

const LAUNCH = {
  // 30本の棒（約1,000px）が収まらない幅にして、横送りが要る形にする
  windowSize: { width: 900, height: 760 },
  settings: { "novelai.stats.dailyGoal": 10 } as Record<string, unknown>,
  prepareWork: async ({ workFolder }: { workFolder: string }) => writeStatsFile(workFolder, belowGoalDays()),
};

test("目標の札は、縦軸の数字と重ならず、棒の並びの右の外に出て、開いたときに右端から見える", async () => {
  await withVsCode("統計の目標の札", [EPISODE], async (session) => {
    const frame = await openStats(session);

    // 日ごとのグラフは横に長く、開いたときは右端（今日の側）から見えている
    const start = await chartScroll(frame);
    expect(start.scrollWidth, "グラフは窓より横に長い").toBeGreaterThan(start.client);
    expect(start.atRight, `開いたときは右端から見える ${JSON.stringify(start)}`).toBe(true);

    const labels = await chartBoxes(frame, ".goal-label");
    expect(labels, "目標の札").toHaveLength(1);
    expect(labels[0].text).toBe("目標 10");
    const goal = labels[0];

    // どの日も目標に届かず、目標の線がいちばん上になる＝縦軸の「10字」と同じ高さ。
    // 札を左の縦軸に置くと重なるので、棒の並びの右の外へ出している
    const bars = await chartBoxes(frame, "rect.bar");
    const lastBarRight = Math.max(...bars.map((bar) => bar.right));
    expect(goal.left, "札は最後の棒の右にある").toBeGreaterThanOrEqual(lastBarRight);
    const overlapsBar = bars.filter((bar) => goal.left < bar.right && bar.left < goal.right && goal.top < bar.bottom && bar.top < goal.bottom);
    expect(overlapsBar, "札と重なる棒").toEqual([]);
    // 縦軸の数字（`.tick`）とも重ならない
    const ticks = (await chartBoxes(frame, "text.tick")).filter((tick) => tick.text !== goal.text);
    const overlapsTick = ticks.filter((tick) => goal.left < tick.right && tick.left < goal.right && goal.top < tick.bottom && tick.top < goal.bottom);
    expect(overlapsTick.map((tick) => tick.text), "札と重なる数字").toEqual([]);
    // 右端から見ているので、札も窓の中に見えている（箱の右端を越えない）
    const wrapRight = await frame.evaluate(() => ((document.getElementById("chart") as Element).parentElement as HTMLElement).getBoundingClientRect().right);
    expect(goal.right, "札が窓の中に収まる").toBeLessThanOrEqual(wrapRight + 1);
  }, LAUNCH);
});

test("左へ送ったあと描き直されても引き戻されず、話ごとの文字数から戻ったとき・日次と週次を切り替えたときは右端から見える", async () => {
  await withVsCode("統計の右端", [EPISODE], async (session) => {
    const frame = await openStats(session);
    expect((await chartScroll(frame)).atRight).toBe(true);

    // 作者が左へ送る（右端から離れる）
    await frame.evaluate(() => {
      ((document.getElementById("chart") as Element).parentElement as HTMLElement).scrollLeft = 0;
    });
    await waitUntil(async () => !(await chartScroll(frame)).atRight, "左へ送れる", 5_000);

    // 描き直し（作品の種類を変えると、開いている統計が送り直される。保存のときの描き直しと同じ道）。
    // **左へ送ったままで、引き戻されない**
    await setWorkKind(session.page, "エッセイ・記事");
    await frame.locator('.tab[data-page="episodes"]').click();
    await waitUntil(async () => (await frame.locator("#episode-cards .card", { hasText: "種類の目安" }).count()) === 1, "描き直された（種類の目安の札が出る）", 30_000);
    await frame.locator('.tab[data-page="writing"]').click();
    // 戻ると右端へ合わせる道が働くので、その前の「描き直しのあいだ」の状態は、左へ送り直して見る
    await frame.evaluate(() => {
      ((document.getElementById("chart") as Element).parentElement as HTMLElement).scrollLeft = 0;
    });
    await waitUntil(async () => !(await chartScroll(frame)).atRight, "左へ送り直せる", 5_000);
    await setWorkKind(session.page, "小説");
    await waitUntil(async () => (await frame.locator("#episode-cards .card", { hasText: "種類の目安" }).count()) === 0, "小説へ戻すと札が消える（描き直し）", 30_000);
    const after = await chartScroll(frame);
    expect(after.atRight, `描き直しで右端へ引き戻されていない ${JSON.stringify(after)}`).toBe(false);
    expect(after.left, "左に送ったまま").toBeLessThan(50);

    // 週次に切り替えて日次へ戻すと、右端から見える（刻みを替えたら、いちばん新しい期間から）
    await frame.locator('[data-granularity="weekly"]').click();
    await frame.locator('[data-granularity="daily"]').click();
    await waitUntil(async () => (await chartScroll(frame)).atRight, "日次へ戻すと右端から見える", 10_000);

    // 「話ごとの文字数」を見ているあいだ（日ごとのグラフは隠れていて、幅が0）に描き直されても、
    // 戻ると右端から見える（隠れているあいだの描き直しで、右端へ合わせ損ねない）。
    // ※左へ送ったままの往復は引き戻さない（作者が見ている位置を守る。設計どおり）
    await frame.locator('.tab[data-page="episodes"]').click();
    await setWorkKind(session.page, "エッセイ・記事");
    await waitUntil(async () => (await frame.locator("#episode-cards .card", { hasText: "種類の目安" }).count()) === 1, "隠れているあいだに描き直される", 30_000);
    await frame.locator('.tab[data-page="writing"]').click();
    await waitUntil(async () => (await chartScroll(frame)).atRight, "戻ると右端から見える", 10_000);
  }, LAUNCH);
});

/** 11話。どの話も約6,000字（原稿用紙で約15枚。「第10話」「約15枚」が折れるかを見る形） */
function longEpisodes(): Array<{ name: string; text: string }> {
  const body = `${"あいうえおかきくけこ".repeat(60)}\n`.repeat(10);
  return Array.from({ length: 11 }, (_, index) => ({
    name: `${String(index + 1).padStart(3, "0")}_第${index + 1}話.txt`,
    text: body,
  }));
}

test("作品の種類を変えると、開いている統計の「目安」の列と「種類の目安」の札が出て、小説へ戻すと消える。表の字は折れない", async () => {
  await withVsCode(
    "統計の話ごとの文字数",
    longEpisodes(),
    async (session) => {
      const frame = await openStatsWithoutBars(session);
      await frame.locator('.tab[data-page="episodes"]').click();
      await waitUntil(async () => (await frame.locator("#episode-table tbody tr").count()) === 11, "11話の表が描かれる", 20_000);

      // 小説：これまでと同じ列のまま（目安の列も札も無い）
      expect(await frame.locator("#episode-table th.measure").count(), "小説の目安の列").toBe(0);
      expect(await frame.locator("#episode-cards .card", { hasText: "種類の目安" }).count(), "小説の札").toBe(0);

      // エッセイ・記事へ：閉じずに、列と札が出る（描き直し）
      await setWorkKind(session.page, "エッセイ・記事");
      await waitUntil(async () => (await frame.locator("#episode-table th.measure").count()) === 1, "目安の列が出る", 30_000);
      expect(await frame.locator("#episode-cards .card", { hasText: "種類の目安" }).count(), "種類の目安の札").toBe(1);
      const measures = await frame.locator("#episode-table td.measure").allInnerTexts();
      expect(measures).toHaveLength(11);
      for (const text of measures) expect(text.trim()).toMatch(/^読了 約\d+分$/);

      // 「第10話」「約15枚」「読了 約N分」が1行に収まる（折り返さない）
      const wrapped = await frame.evaluate(() => {
        const lines = (cell: Element): number => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
        };
        return Array.from(document.querySelectorAll("#episode-table td.nowrap, #episode-table td.measure"))
          .filter((cell) => lines(cell) > 1)
          .map((cell) => (cell.textContent ?? "").trim());
      });
      expect(wrapped, "折り返している字").toEqual([]);
      const labels = await frame.locator("#episode-table td.nowrap").allInnerTexts();
      expect(labels, "第10話の行").toContain("第10話");
      expect((await frame.locator("#episode-table td.nowrap", { hasText: /^約\d+枚$/ }).count()), "原稿用紙の列").toBeGreaterThanOrEqual(11);

      // 細い窓：表だけが横に送れ（表の下に横送りの帯）、画面全体は横にずれない
      const widths = await frame.evaluate(() => {
        const scroll = document.getElementById("episode-table") as HTMLElement;
        const root = document.scrollingElement as HTMLElement;
        return { table: [scroll.scrollWidth, scroll.clientWidth], page: [root.scrollWidth, root.clientWidth] };
      });
      expect(widths.table[0], "表は窓より横に長い（横に送る帯が出る）").toBeGreaterThan(widths.table[1]);
      expect(widths.page[0], "画面全体は横にずれない").toBeLessThanOrEqual(widths.page[1] + 1);

      // 小説へ戻すと、列も札も消える
      await setWorkKind(session.page, "小説");
      await waitUntil(async () => (await frame.locator("#episode-table th.measure").count()) === 0, "小説へ戻すと列が消える", 30_000);
      expect(await frame.locator("#episode-cards .card", { hasText: "種類の目安" }).count()).toBe(0);
    },
    { windowSize: { width: 700, height: 760 } }
  );
});

/** 執筆統計の画面を開く（日ごとの棒が描かれるのは待たない。記録が無い作品でも使える） */
async function openStatsWithoutBars(session: E2ESession): Promise<Frame> {
  await runCommand(session.page, "執筆統計");
  let frame: Frame | undefined;
  await waitUntil(async () => (frame = await statsFrame(session.page)) !== undefined, "執筆統計の画面が開く", 30_000);
  if (!frame) throw new Error("執筆統計の面が見つかりません");
  return frame;
}
