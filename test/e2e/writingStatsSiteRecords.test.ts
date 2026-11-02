/**
 * 執筆統計のサイトのタブの中身・狭い幅・0.119.0 の覚えからの移り（画面の自動テスト、設計書6.3.9・6.79.7・6.113。
 * 実機確認リスト 0.120.1「タブが1段で…」と 0.121.0「順位の推移（上ほど上位）…」のうち、
 * writingStatsSiteTabs が見ていない残りを機械へ移した。作者の指示 2026-11-01「二段のタブとせず」・
 * 2026-11-02「順位もグラフに」）。
 *
 * 見張ること：
 * 1. 各サイトのタブに、そのサイトの記録だけが出る（カクヨムのタブにカクヨムの作品ID・タグ・PV、なろうのタブに
 *    なろうの順位の表）。タグの食い違い（カクヨムにだけある「学園」）は、カクヨムのタブにだけ
 *    「ほかのサイトに無いタグ：学園」と出る
 * 2. 増減のグラフ（日ごとのブックマーク・評価ポイントの増減）には順位が出ない：アルファポリスの日ごとの記録に
 *    累計ランキング（小さいほど良い数）を混ぜても「累計ランキングの増減」のグラフは出ず、増減の棒の数は
 *    ブックマークの数だけで「位」を含まない。なろうのタブでも、順位の推移のグラフとは別に増減の棒が出て、
 *    棒に順位の数が入らない
 * 3. 幅 360px ほど（窓を細くして左の列を閉じる）で、概要・各サイトのタブのどれも横へ送らずに読め
 *    （頁の横幅が面の幅を超えない）、タブは2段以上に折り返す。なろうのタブでは順位の推移のグラフも面の中に収まる
 * 4. 0.119.0 で「読者の反応」→なろうを見ていた作品（保管庫の古い形）は、開くと「なろうの反応」で開く。
 *    覚えの表の鍵は登録のときに決まる作品IDなので、登録のあと VS Code を閉じて、閉じている間に保管庫を
 *    古い形へ書き換えてから起こし直す（`restartVsCode` の `beforeRelaunch`）
 *
 * **作者の目に残すもの**：暗いテーマで読めるか・線の色の見分け・グラフの見た目の良し悪し。
 * 増減の棒・表は中で横に送れる作り（`.chart-wrap`・`.table-scroll`）なので、頁の横幅だけを見る。
 * **本物のなろうの API は呼ばない**（取得のボタンは押さない）。**AI は呼ばない。**
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { READER_SITE_TAB_MEMORY_KEY, WRITING_STATS_TAB_MEMORY_KEY } from "../../src/core/writingStatsTabMemory";
import { statsFrame } from "./support/statsFixture";
import { editGlobalState, restartVsCode, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = { name: "001_はじまり.txt", text: "一行目の文。\n" };

const KAKUYOMU_ID = "1177354054880000000";
const NCODE = "n1234ab";
const KAKUYOMU_SITE = { site: "kakuyomu", newEpisodeUrl: `https://kakuyomu.jp/my/works/${KAKUYOMU_ID}/episodes/new` };
const ALPHAPOLIS_SITE = { site: "alphapolis", newEpisodeUrl: "https://www.alphapolis.co.jp/mypage/novel/save_episode/123456789" };
const NAROU_SITE = { site: "narou", newEpisodeUrl: `https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/${NCODE}/` };

/** カクヨムの PV（ほかのサイトのタブに出ないことを見る目印。ほかの数と重ならない値） */
const KAKUYOMU_PV = 321;

/** 日ごとの記録1件（`models/posting.ts` の ReaderStatsRecord） */
function dayRecord(site: string, day: string, metrics: Record<string, number>): Record<string, unknown> {
  return { site, readAt: `${day}T21:00:00+09:00`, scope: "work", period: "day", periodKey: day, metrics, source: "helper" };
}

/** 3つのサイトを登録し、サイトごとに違う記録を置いた台帳 */
function threeSitesLedger(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    sites: [NAROU_SITE, KAKUYOMU_SITE, ALPHAPOLIS_SITE],
    siteProfiles: [
      { site: "narou", workId: NCODE },
      { site: "kakuyomu", workId: KAKUYOMU_ID },
    ],
    posts: [],
    rankings: [
      { site: "narou", recordedAt: "2026-10-01T00:00:00+09:00", board: "日間", rank: 50, source: "narou-api" },
      { site: "narou", recordedAt: "2026-10-02T00:00:00+09:00", board: "日間", rank: 30, source: "narou-api" },
      { site: "narou", recordedAt: "2026-10-03T00:00:00+09:00", board: "日間", rank: 10, source: "narou-api" },
    ],
    readerStats: [
      { site: "kakuyomu", readAt: "2026-10-03T21:00:00+09:00", scope: "work", metrics: { pv: KAKUYOMU_PV }, source: "manual" },
      // アルファポリス：お気に入りの増減と、累計ランキング（小さいほど良い）を同じ日の行に入れる
      dayRecord("alphapolis", "2026-10-01", { bookmarks: 5, alphapolis_rankTotal: 300 }),
      dayRecord("alphapolis", "2026-10-02", { bookmarks: 7, alphapolis_rankTotal: 250 }),
      dayRecord("alphapolis", "2026-10-03", { bookmarks: 2, alphapolis_rankTotal: 260 }),
      // なろう：Narou.fun の日ごとの表の形（ブックマークと評価ポイントの増減。減った日もある）
      dayRecord("narou", "2026-10-01", { bookmarks: 3, narou_ratingPoints: 4 }),
      dayRecord("narou", "2026-10-02", { bookmarks: 1, narou_ratingPoints: -2 }),
      dayRecord("narou", "2026-10-03", { bookmarks: 6, narou_ratingPoints: 8 }),
    ],
    siteFacts: [
      { site: "kakuyomu", tags: ["異世界", "魔法", "学園"], tagsAt: "2026-10-03T21:00:00+09:00" },
      { site: "narou", tags: ["異世界", "魔法"], tagsAt: "2026-10-03T21:00:00+09:00" },
    ],
  };
}

const PREPARE: LaunchOptions["prepareWork"] = async ({ workFolder }) => {
  await mkdir(path.join(workFolder, "設定"), { recursive: true });
  await writeFile(path.join(workFolder, "設定", "投稿状態.json"), JSON.stringify(threeSitesLedger(), null, 2), "utf8");
};

const OPEN_STATS_KEY = { key: "ctrl+alt+shift+u", command: "novelai.showWritingStats" };
const OPEN_STATS_PRESS = "Control+Alt+Shift+KeyU";
const CLOSE_EDITOR_KEY = { key: "ctrl+alt+shift+w", command: "workbench.action.closeActiveEditor" };
const CLOSE_EDITOR_PRESS = "Control+Alt+Shift+KeyW";
/** 左の列を閉じる（数字のキーは製品の package.json とも、ほかの件とも重ならない） */
const CLOSE_SIDEBAR_KEY = { key: "ctrl+alt+shift+1", command: "workbench.action.closeSidebar" };
const CLOSE_SIDEBAR_PRESS = "Control+Alt+Shift+Digit1";

async function openStats(page: Page): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_STATS_PRESS);
  let frame: Frame | undefined;
  await waitUntil(async () => (frame = await statsFrame(page)) !== undefined, "執筆統計の画面が開く", 30_000);
  const found = frame as Frame;
  await waitUntil(async () => (await found.locator(".tab[data-site]").count()) === 3, "サイトのタブが3つ出る", 20_000);
  return found;
}

async function activeTabKey(frame: Frame): Promise<string | undefined> {
  return frame.evaluate(() => (document.querySelector("#tabs .tab.active") as HTMLElement | null)?.dataset.page);
}

async function showTab(frame: Frame, key: string): Promise<void> {
  await frame.locator(`.tab[data-page="${key}"]`).click();
  await waitUntil(async () => (await activeTabKey(frame)) === key, `「${key}」のタブが前に出る`, 10_000);
}

/** サイトのタブの面の字と、見出し（`.site-sub`）の並び */
async function sitePage(frame: Frame, site: string): Promise<{ text: string; subs: string[] }> {
  return frame.evaluate((key) => {
    const page = document.querySelector(`#page-site-${key}`) as HTMLElement | null;
    return {
      text: page?.textContent ?? "",
      subs: Array.from(page?.querySelectorAll(".site-sub") ?? []).map((node) => (node.textContent ?? "").trim()),
    };
  }, site);
}

/** 増減のグラフ（見出しに「増減」を含むもの）ごとの、棒の吹き出しの字 */
async function changeCharts(frame: Frame, site: string): Promise<Array<{ title: string; bars: string[] }>> {
  return frame.evaluate((key) => {
    const page = document.querySelector(`#page-site-${key}`);
    return Array.from(page?.querySelectorAll(".site-sub") ?? [])
      .filter((node) => (node.textContent ?? "").includes("増減"))
      .map((node) => {
        // 見出しのすぐあとの .chart-wrap が、その見出しのグラフ（readerChartBlock の並び）
        let next = node.nextElementSibling;
        while (next && !next.classList.contains("chart-wrap") && !next.classList.contains("site-sub")) next = next.nextElementSibling;
        const wrap = next && next.classList.contains("chart-wrap") ? next : null;
        return {
          title: (node.textContent ?? "").trim(),
          bars: Array.from(wrap?.querySelectorAll("rect.bar title") ?? []).map((title) => title.textContent ?? ""),
        };
      });
  }, site);
}

/* ── 1. 各サイトのタブの記録とタグの食い違い ── */

test("各サイトのタブにはそのサイトの記録だけが出て、カクヨムにだけあるタグはカクヨムのタブにだけ「ほかのサイトに無いタグ：学園」と出る", async () => {
  await withVsCode(
    "統計のサイトのタブの中身",
    [EPISODE],
    async (session) => {
      const frame = await openStats(session.page);

      await showTab(frame, "site-kakuyomu");
      let kakuyomu = await sitePage(frame, "kakuyomu");
      await waitUntil(async () => (kakuyomu = await sitePage(frame, "kakuyomu")).text.includes("学園"), "カクヨムのタブにタグが出る", 15_000).catch(
        (error: unknown) => {
          throw new Error(`${String(error)}（カクヨムのタブ：${kakuyomu.text.slice(0, 400)}）`);
        }
      );
      expect(kakuyomu.text, "カクヨムの作品IDが出ていません").toContain(`作品ID ${KAKUYOMU_ID}`);
      expect(kakuyomu.text, "カクヨムの PV が出ていません").toContain(String(KAKUYOMU_PV));
      expect(kakuyomu.text, `タグの食い違いがカクヨムのタブに出ていません：${kakuyomu.text.slice(0, 400)}`).toContain("ほかのサイトに無いタグ：学園");
      // なろうの順位（日間）はカクヨムのタブに出ない
      expect(kakuyomu.text.includes("日間"), "カクヨムのタブになろうの順位が出ています").toBe(false);

      await showTab(frame, "site-narou");
      const narou = await sitePage(frame, "narou");
      expect(narou.text, "なろうのタブに順位の表が出ていません").toContain("日間");
      expect(narou.text, "なろうのタブに Nコードが出ていません").toContain(`作品ID ${NCODE}`);
      expect(narou.text.includes("ほかのサイトに無いタグ"), `なろうのタグはカクヨムにもあるのに食い違いが出ています：${narou.text.slice(0, 400)}`).toBe(false);
      expect(narou.text.includes(KAKUYOMU_ID), "なろうのタブにカクヨムの作品IDが出ています").toBe(false);
      expect(narou.text.includes("学園"), "なろうのタブにカクヨムのタグが出ています").toBe(false);

      await showTab(frame, "site-alphapolis");
      const alphapolis = await sitePage(frame, "alphapolis");
      expect(alphapolis.text.includes("ほかのサイトに無いタグ"), "タグの届いていないアルファポリスに食い違いが出ています").toBe(false);
      expect(alphapolis.text.includes(KAKUYOMU_ID) || alphapolis.text.includes("学園"), "アルファポリスのタブにカクヨムの記録が出ています").toBe(false);
      expect(alphapolis.text.includes("日間"), "アルファポリスのタブになろうの順位が出ています").toBe(false);
    },
    { keybindings: [OPEN_STATS_KEY], prepareWork: PREPARE }
  );
});

/* ── 2. 増減のグラフに順位が出ない ── */

test("増減のグラフ（ブックマーク・評価ポイント）には順位が出ず、アルファポリスの累計ランキングは増減のグラフにならない", async () => {
  await withVsCode(
    "統計の増減のグラフと順位",
    [EPISODE],
    async (session) => {
      const frame = await openStats(session.page);

      await showTab(frame, "site-alphapolis");
      let alpha: Array<{ title: string; bars: string[] }> = [];
      await waitUntil(async () => (alpha = await changeCharts(frame, "alphapolis")).length > 0, "アルファポリスのタブに増減のグラフが出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（見出し：${JSON.stringify((await sitePage(frame, "alphapolis")).subs)}）`);
        }
      );
      expect(alpha.map((chart) => chart.title), `増減のグラフ：${JSON.stringify(alpha)}`).toEqual(["日ごとのブックマークの増減（作品全体）"]);
      for (const chart of alpha) {
        expect(chart.bars.length, `棒がありません：${JSON.stringify(chart)}`).toBe(3);
        expect(chart.bars.some((bar) => bar.includes("位")), `増減の棒に順位が出ています：${JSON.stringify(chart)}`).toBe(false);
        // 棒の数はブックマークの数（+5・+7・+2）。累計ランキングの数（300・250・260）は入らない
        expect(chart.bars.map((bar) => bar.replace(/^\S+\s+/, "")), JSON.stringify(chart)).toEqual(["+5 ブックマーク", "+7 ブックマーク", "+2 ブックマーク"]);
      }
      const alphaSubs = (await sitePage(frame, "alphapolis")).subs;
      expect(alphaSubs.some((sub) => sub.includes("ランキング") && sub.includes("増減")), `ランキングの増減のグラフがあります：${JSON.stringify(alphaSubs)}`).toBe(false);

      await showTab(frame, "site-narou");
      const narou = await changeCharts(frame, "narou");
      expect(narou.map((chart) => chart.title).sort(), `なろうの増減のグラフ：${JSON.stringify(narou)}`).toEqual(
        ["日ごとのブックマークの増減（作品全体）", "日ごとの評価ポイントの増減（作品全体）"].sort()
      );
      for (const chart of narou) {
        expect(chart.bars.some((bar) => bar.includes("位")), `増減の棒に順位が出ています：${JSON.stringify(chart)}`).toBe(false);
      }
      // 順位は順位の推移のグラフにだけ出る（同じタブに両方ある）
      const narouSubs = (await sitePage(frame, "narou")).subs;
      expect(narouSubs, JSON.stringify(narouSubs)).toContain("順位の推移（上ほど上位）");
      expect(narouSubs.filter((sub) => sub.includes("順位")), `順位の見出しが増減のグラフにもあります：${JSON.stringify(narouSubs)}`).toEqual(["順位の推移（上ほど上位）"]);
    },
    { keybindings: [OPEN_STATS_KEY], prepareWork: PREPARE }
  );
});

/* ── 3. 幅 360px ほど ── */

interface NarrowMeasure {
  key: string;
  clientWidth: number;
  scrollWidth: number;
  tabRows: number;
  rankChartRight: number | null;
}

test("幅 360px ほどでも、概要と各サイトのタブは横へ送らずに読め、タブは折り返し、順位の推移のグラフも面の中に収まる", async () => {
  await withVsCode(
    "統計の狭い幅",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await pressWorkbenchKey(page, CLOSE_SIDEBAR_PRESS);
      const frame = await openStats(page);
      const results: NarrowMeasure[] = [];
      for (const key of ["overview", "site-kakuyomu", "site-alphapolis", "site-narou"]) {
        await showTab(frame, key);
        // 描き直しが落ち着くのを少し待つ（グラフは前に出てから幅を測って描くことがある）
        await page.waitForTimeout(500);
        results.push(
          await frame.evaluate((tab) => {
            const rows = new Set(Array.from(document.querySelectorAll("#tabs .tab")).map((node) => Math.round(node.getBoundingClientRect().top)));
            const chart = document.querySelector(`#page-${tab} .rank-chart svg`);
            return {
              key: tab,
              clientWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
              tabRows: rows.size,
              rankChartRight: chart ? Math.round(chart.getBoundingClientRect().right) : null,
            };
          }, key)
        );
      }
      const detail = JSON.stringify(results);
      // 前提：面の幅が 360px ほどになっている（違えば台の形が違う）
      expect(results[0].clientWidth, `面の幅が 360px ほどになっていません：${detail}`).toBeGreaterThanOrEqual(300);
      expect(results[0].clientWidth, `面の幅が 360px ほどになっていません：${detail}`).toBeLessThanOrEqual(380);
      for (const result of results) {
        expect(result.scrollWidth, `「${result.key}」で横へ送らないと読めません：${detail}`).toBeLessThanOrEqual(result.clientWidth + 1);
        expect(result.tabRows, `狭いのにタブが1段のままです：${detail}`).toBeGreaterThanOrEqual(2);
      }
      const narou = results.find((result) => result.key === "site-narou") as NarrowMeasure;
      expect(narou.rankChartRight, `なろうのタブに順位の推移のグラフがありません：${detail}`).not.toBeNull();
      expect(narou.rankChartRight as number, `順位の推移のグラフが面の外へ出ています：${detail}`).toBeLessThanOrEqual(narou.clientWidth + 1);
    },
    {
      keybindings: [OPEN_STATS_KEY, CLOSE_SIDEBAR_KEY],
      prepareWork: PREPARE,
      windowSize: { width: 420, height: 800 },
    }
  );
});

/* ── 4. 0.119.0 の覚えからの移り ── */

test("0.119.0 で「読者の反応」のなろうを見ていた作品は、執筆統計を開くと「なろうの反応」で開く", async () => {
  await withVsCode(
    "統計の古い覚えからの移り",
    [EPISODE],
    async (session: E2ESession) => {
      // 対照：覚えが無いうちは概要で開く
      const first = await openStats(session.page);
      await waitUntil(async () => (await activeTabKey(first)) !== undefined, "前に出ているタブが決まる", 10_000);
      expect(await activeTabKey(first), "覚えが無いのに概要以外で開きました").toBe("overview");
      await pressWorkbenchKey(session.page, CLOSE_EDITOR_PRESS);
      await waitUntil(async () => (await statsFrame(session.page)) === undefined, "執筆統計が閉じる", 15_000);

      // 閉じている間に、保管庫を 0.119.0 の形（外側は「読者の反応」、中のサイトはなろう）へ書き換える
      let workId = "";
      await restartVsCode(session, {
        beforeRelaunch: () =>
          editGlobalState(session.root, (values) => {
            const works = (values["novelai.works"] ?? []) as Array<{ id: string; folderPath: string }>;
            const work = works.find((entry) => path.resolve(entry.folderPath) === path.resolve(session.workFolder));
            if (!work) throw new Error(`登録簿に作品がありません：${JSON.stringify(works)}`);
            workId = work.id;
            values[WRITING_STATS_TAB_MEMORY_KEY] = { [work.id]: "readers" };
            values[READER_SITE_TAB_MEMORY_KEY] = { [work.id]: "narou" };
          }),
      });
      const reopened = await openStats(session.page);
      await waitUntil(async () => (await activeTabKey(reopened)) === "site-narou", "古い覚えの作品が「なろうの反応」で開く", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまのタブ：${await activeTabKey(reopened)}／作品ID：${workId}）`);
        }
      );
    },
    { keybindings: [OPEN_STATS_KEY, CLOSE_EDITOR_KEY], prepareWork: PREPARE }
  );
}, 240_000);
