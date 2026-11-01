/**
 * 執筆統計のサイトのタブ・なろうAPIの同意の欄・順位の推移のグラフ・順位のお祝い（画面の自動テスト、
 * 設計書6.3.9・6.79.7・6.113。実機確認リスト 0.120.1 と 0.121.0 の項目を機械へ移した。
 * 作者の指示 2026-11-01「二段のタブとせず」・2026-11-02「なろうAPI」「順位もグラフに」「風船とか花火」）。
 *
 * 見張ること：
 * 1. 投稿先にカクヨム・アルファポリス・なろうを登録した作品（台帳の並びはなろうを先頭に置く）で、
 *    タブが「概要」「執筆の推移」「話ごと」「カクヨムの反応」「アルファの反応」「なろうの反応」の順に
 *    1段で並び、登録していない note のタブは出ない。最後のタブで右の矢印キーを押すと先頭へ回る。
 *    「なろうの反応」を見て閉じ、開き直すと「なろうの反応」で開く
 * 2. なろうAPIの欄：ガイドラインを開いていないと、同意のチェックは押せず「先にガイドラインを開いて
 *    ください」、ボタンも押せない。**リンクは押さない**（`vscode.env.openExternal` で作者の本物の
 *    ブラウザが開くため）。代わりに「開いた」記録を保管庫（globalState の `novelai.narouApi.consent`。
 *    製品が開けたときに書くのと同じ形）へ起こす前に置き、そこからの動き（チェックが押せる → 入れると
 *    ボタンが押せて同意の日時が出る → 外すとまた押せない）を見る。VS Code を起こし直しても同意が残る
 * 3. Nコードの無い（なろうに登録しただけの）作品では「投稿サイト設定で Nコードを登録すると使えます。」
 *    だけが出て、チェックもボタンも無い
 * 4. 順位の推移：なろうの日間（API の順位。2日空いた所が圏外）と週間（手の記録）で、線が種別ごとに
 *    色の組を分けて描かれ（日間は圏外で2本に切れる）、凡例が2つ、1位側が上。順位の無いカクヨムの
 *    タブには「『ランキング記録』で順位を残すと、ここに推移が出ます。」の1行
 * 5. 順位のお祝い：「ランキング記録」で下がった順位では何も出ず、前より良い順位を記録すると
 *    「「〈作品〉」がカクヨムの週間で30位から12位に上がりました！」が1回出て、開いている執筆統計に
 *    「おめでとうございます」の札が出る。同じ記録をもう一度入れても二度は出ない。閉じていた作品では
 *    次に開いたときに1回だけ札が出る（開き直すともう出ない）
 *
 * **作者の目に残すもの**：幅 360px での折り返し・暗いテーマで読めるか・線の色の見分け・風船と花火の
 * 動きと規模・OS の「アニメーションを減らす」。本物のなろうの API は呼ばない（取得のボタンは押さない）。
 * **AI は呼ばない。**
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { NAROU_GUIDELINE_URL } from "../../src/core/narouApi";
import { NAROU_API_CONSENT_KEY } from "../../src/core/narouApiGate";
import { answerInput, waitForQuickInput, waitQuickInputClosed } from "./support/quickInput";
import { SIDEBAR_LAUNCH, showSidebar, treeContextMenu } from "./support/sidebar";
import { statsFrame } from "./support/statsFixture";
import { E2E_WORK_TITLE, restartVsCode, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, notificationTexts, pickQuickPickRow, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = { name: "001_はじまり.txt", text: "一行目の文。\n" };

const KAKUYOMU_ID = "1177354054880000000";
const NCODE = "n1234ab";
const KAKUYOMU_SITE = { site: "kakuyomu", newEpisodeUrl: `https://kakuyomu.jp/my/works/${KAKUYOMU_ID}/episodes/new` };
const ALPHAPOLIS_SITE = { site: "alphapolis", newEpisodeUrl: "https://www.alphapolis.co.jp/mypage/novel/save_episode/123456789" };
const NAROU_SITE = { site: "narou", newEpisodeUrl: `https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/${NCODE}/` };

/** なろうの日間（API の順位）。10-02 の次が 10-05 で、日間は毎日出るので 10-03 は圏外 */
const NAROU_DAILY = [
  { day: "2026-10-01", rank: 50 },
  { day: "2026-10-02", rank: 30 },
  { day: "2026-10-05", rank: 20 },
  { day: "2026-10-06", rank: 10 },
];
/** なろうの週間（手の記録）。書いていない日は圏外と言えないので、点どうしを結ぶ */
const NAROU_WEEKLY = [
  { at: "2026-10-03T12:00:00.000Z", rank: 80 },
  { at: "2026-10-10T12:00:00.000Z", rank: 40 },
];

/** 製品が読む形の投稿状態の台帳（`models/posting.ts` の PostingLedger） */
function ledger(options: { sites: unknown[]; profiles: unknown[]; rankings?: unknown[] }): Record<string, unknown> {
  return {
    schemaVersion: "1",
    sites: options.sites,
    siteProfiles: options.profiles,
    posts: [],
    rankings: options.rankings ?? [],
    readerStats: [],
  };
}

/** 3つのサイトを登録し、なろうに順位を置いた台帳（**並びはなろうを先頭**——タブの並びが台帳の並びに引きずられないかを見る） */
function threeSitesLedger(): Record<string, unknown> {
  return ledger({
    sites: [NAROU_SITE, KAKUYOMU_SITE, ALPHAPOLIS_SITE],
    profiles: [
      { site: "narou", workId: NCODE },
      { site: "kakuyomu", workId: KAKUYOMU_ID },
    ],
    rankings: [
      ...NAROU_DAILY.map((point) => ({
        site: "narou",
        recordedAt: `${point.day}T00:00:00+09:00`,
        board: "日間",
        rank: point.rank,
        source: "narou-api",
      })),
      ...NAROU_WEEKLY.map((point) => ({ site: "narou", recordedAt: point.at, board: "週間", rank: point.rank })),
    ],
  });
}

function writeLedgerBeforeLaunch(body: () => Record<string, unknown>): LaunchOptions["prepareWork"] {
  return async ({ workFolder }) => {
    await mkdir(path.join(workFolder, "設定"), { recursive: true });
    await writeFile(path.join(workFolder, "設定", "投稿状態.json"), JSON.stringify(body(), null, 2), "utf8");
  };
}

const CLOSE_EDITOR_KEY = { key: "ctrl+alt+shift+w", command: "workbench.action.closeActiveEditor" };
const OPEN_STATS_KEY = { key: "ctrl+alt+shift+u", command: "novelai.showWritingStats" };
const OPEN_STATS_PRESS = "Control+Alt+Shift+KeyU";

/** 執筆統計を開き、面とサイトのタブが届くまで待つ */
async function openStats(page: Page, wantSiteTabs: number): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_STATS_PRESS);
  let frame: Frame | undefined;
  await waitUntil(async () => (frame = await statsFrame(page)) !== undefined, "執筆統計の画面が開く", 30_000);
  const found = frame as Frame;
  await waitUntil(
    async () => (await found.locator(".tab[data-site]").count()) === wantSiteTabs,
    `サイトのタブが ${wantSiteTabs} つ出る`,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまのタブ：${JSON.stringify(await tabLabels(found))}）`);
  });
  return found;
}

/** タブの名前（左から） */
async function tabLabels(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => Array.from(document.querySelectorAll("#tabs .tab")).map((node) => (node.textContent ?? "").trim()));
}

async function activeTabKey(frame: Frame): Promise<string | undefined> {
  return frame.evaluate(() => (document.querySelector("#tabs .tab.active") as HTMLElement | null)?.dataset.page);
}

async function closeStats(page: Page): Promise<void> {
  await pressWorkbenchKey(page, "Control+Alt+Shift+KeyW");
  await waitUntil(async () => (await statsFrame(page)) === undefined, "執筆統計が閉じる", 15_000);
}

/** なろうの反応の面の、なろうAPIの欄の様子 */
async function narouApiState(frame: Frame): Promise<{
  present: boolean;
  text: string;
  agreeExists: boolean;
  agreeDisabled: boolean;
  agreeChecked: boolean;
  fetchExists: boolean;
  fetchDisabled: boolean;
}> {
  return frame.evaluate(() => {
    const box = document.querySelector("#page-site-narou .narou-api") as HTMLElement | null;
    const agree = box?.querySelector("[data-narou-agree]") as HTMLInputElement | null;
    const fetchButton = box?.querySelector("[data-narou-fetch]") as HTMLButtonElement | null;
    return {
      present: box !== null,
      text: box?.textContent ?? "",
      agreeExists: agree !== null && agree !== undefined,
      agreeDisabled: agree?.disabled ?? true,
      agreeChecked: agree?.checked ?? false,
      fetchExists: fetchButton !== null && fetchButton !== undefined,
      fetchDisabled: fetchButton?.disabled ?? true,
    };
  });
}

/* ── 1. タブの並び・矢印キー・覚えたタブ ── */

test("投稿先を3つ登録した作品では、タブが概要・執筆の推移・話ごと・カクヨム・アルファ・なろうの順に1段で並び、note は出ず、最後で右の矢印キーを押すと先頭へ回り、なろうの反応を見て閉じると次もなろうの反応で開く", async () => {
  await withVsCode(
    "統計のサイトのタブの並び",
    [EPISODE],
    async (session) => {
      const { page } = session;
      const frame = await openStats(page, 3);
      expect(await tabLabels(frame)).toEqual(["概要", "執筆の推移", "話ごと", "カクヨムの反応", "アルファの反応", "なろうの反応"]);
      // 「読者の反応」のタブ・中の二段のタブは無い
      expect(await frame.locator(".tab", { hasText: "読者の反応" }).count()).toBe(0);
      expect(await frame.locator('.tab[data-site="note"]').count()).toBe(0);

      // 最後のタブ（なろうの反応）で右の矢印キー → 先頭（概要）へ回る
      await frame.locator('.tab[data-page="site-narou"]').click();
      await waitUntil(async () => (await activeTabKey(frame)) === "site-narou", "なろうの反応のタブが前に出る", 10_000);
      await page.keyboard.press("ArrowRight");
      await waitUntil(async () => (await activeTabKey(frame)) === "overview", "最後のタブで右の矢印キーを押すと概要へ回る", 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまのタブ：${await activeTabKey(frame)}）`);
        }
      );
      // 左の矢印キーで最後（なろうの反応）へ戻る
      await page.keyboard.press("ArrowLeft");
      await waitUntil(async () => (await activeTabKey(frame)) === "site-narou", "先頭で左の矢印キーを押すとなろうの反応へ回る", 10_000);

      // なろうの反応を見たまま閉じて開き直すと、なろうの反応で開く
      await closeStats(page);
      const reopened = await openStats(page, 3);
      await waitUntil(async () => (await activeTabKey(reopened)) === "site-narou", "開き直すと前に見ていた「なろうの反応」で開く", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまのタブ：${await activeTabKey(reopened)}）`);
        }
      );
      expect(await reopened.locator("#page-site-narou.active").count()).toBe(1);
    },
    {
      keybindings: [CLOSE_EDITOR_KEY, OPEN_STATS_KEY],
      prepareWork: writeLedgerBeforeLaunch(threeSitesLedger),
    }
  );
});

/* ── 2. なろうAPIの同意の欄 ── */

test("なろうAPIの欄は、ガイドラインを開くまで同意のチェックもボタンも押せず「先にガイドラインを開いてください」と出る", async () => {
  await withVsCode(
    "なろうAPIの同意（開く前）",
    [EPISODE],
    async (session) => {
      const frame = await openStats(session.page, 3);
      await frame.locator('.tab[data-page="site-narou"]').click();
      await waitUntil(async () => (await narouApiState(frame)).present, "なろうの反応に「なろうAPIによる作品情報取得」の欄が出る", 15_000);
      const state = await narouApiState(frame);
      expect(state.text).toContain("なろうAPIによる作品情報取得");
      expect(state.text).toContain("なろうデベロッパー利用ガイドライン");
      expect(state.text).toContain("先にガイドラインを開いてください");
      expect(state.agreeExists, `同意のチェックがありません：${state.text}`).toBe(true);
      expect(state.agreeDisabled, "ガイドラインを開く前に同意のチェックが押せます").toBe(true);
      expect(state.agreeChecked, "既定でチェックが入っています").toBe(false);
      expect(state.fetchExists, `取得のボタンがありません：${state.text}`).toBe(true);
      expect(state.fetchDisabled, "同意の前に取得のボタンが押せます").toBe(true);
      // 押せないチェックを押しても入らない（disabled なので change は起きない）
      await frame.locator("#page-site-narou [data-narou-agree]").click({ force: true });
      await holdsFor(async () => !(await narouApiState(frame)).agreeChecked && (await narouApiState(frame)).fetchDisabled, "押せないチェックを押しても同意にならない", 2_000);
    },
    {
      keybindings: [OPEN_STATS_KEY],
      prepareWork: writeLedgerBeforeLaunch(threeSitesLedger),
    }
  );
});

test("ガイドラインを開いた記録があると同意のチェックが押せ、入れるとボタンが押せて同意の日時が出て、外すとまた押せなくなり、VS Code を起こし直しても同意が残る", async () => {
  await withVsCode(
    "なろうAPIの同意（開いたあと）",
    [EPISODE],
    async (session: E2ESession) => {
      const { page } = session;
      const frame = await openStats(page, 3);
      await frame.locator('.tab[data-page="site-narou"]').click();
      await waitUntil(async () => (await narouApiState(frame)).present, "なろうAPIの欄が出る", 15_000);
      let state = await narouApiState(frame);
      expect(state.text, "開いた記録があるのに「先にガイドラインを開いてください」が出ます").not.toContain("先にガイドラインを開いてください");
      expect(state.agreeDisabled, "開いた記録があるのに同意のチェックが押せません").toBe(false);
      expect(state.fetchDisabled, "同意の前に取得のボタンが押せます").toBe(true);

      // チェックを入れる → ボタンが押せる・同意の日時が出る
      await frame.locator("#page-site-narou [data-narou-agree]").check();
      await waitUntil(async () => !(state = await narouApiState(frame)).fetchDisabled && state.text.includes("に同意"), "チェックを入れるとボタンが押せ、同意の日時が出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（欄：${JSON.stringify(state)}）`);
        }
      );

      // 外す → 押せない
      await frame.locator("#page-site-narou [data-narou-agree]").uncheck();
      await waitUntil(async () => (state = await narouApiState(frame)).fetchDisabled && !state.agreeChecked, "チェックを外すとボタンがまた押せなくなる", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（欄：${JSON.stringify(state)}）`);
        }
      );

      // もう一度入れて、VS Code を起こし直しても同意と「開いた」が残る
      await frame.locator("#page-site-narou [data-narou-agree]").check();
      await waitUntil(async () => !(await narouApiState(frame)).fetchDisabled, "入れ直すとボタンが押せる", 15_000);
      // 保管庫が本体へ書かれる間を置く（globalState は少しあとで塊ごと送られる。verifiedMemento.ts）
      await page.waitForTimeout(3_000);
      await restartVsCode(session);
      const after = await openStats(session.page, 3);
      // 前に見ていたなろうの反応で開く
      await waitUntil(async () => (await narouApiState(after)).present, "起こし直したあともなろうAPIの欄が出る", 20_000);
      const kept = await narouApiState(after);
      expect(kept.agreeChecked, `起こし直したら同意が消えました：${JSON.stringify(kept)}`).toBe(true);
      expect(kept.agreeDisabled, "起こし直したら「開いた」が消えました").toBe(false);
      expect(kept.fetchDisabled, "起こし直したらボタンが押せなくなりました").toBe(false);
      // 取得のボタンは押さない（本物のなろうの API を呼ぶため）
    },
    {
      keybindings: [OPEN_STATS_KEY],
      prepareWork: writeLedgerBeforeLaunch(threeSitesLedger),
      // 製品が「開けた」ときに書くのと同じ形（core/narouApiGate.ts の withGuidelineOpened）
      globalState: { [NAROU_API_CONSENT_KEY]: { guidelineUrl: NAROU_GUIDELINE_URL, openedAt: "2026-11-02T00:00:00.000Z" } },
    }
  );
}, 240_000);

test("Nコードの無い（なろうに登録しただけの）作品のなろうの反応には「投稿サイト設定で Nコードを登録すると使えます。」だけが出て、チェックもボタンも無い", async () => {
  await withVsCode(
    "なろうAPI（Nコード無し）",
    [EPISODE],
    async (session) => {
      const frame = await openStats(session.page, 1);
      await frame.locator('.tab[data-page="site-narou"]').click();
      await waitUntil(async () => (await narouApiState(frame)).present, "なろうAPIの欄が出る", 15_000);
      const state = await narouApiState(frame);
      expect(state.text).toContain("投稿サイト設定で Nコードを登録すると使えます。");
      expect(state.agreeExists, "Nコードが無いのに同意のチェックがあります").toBe(false);
      expect(state.fetchExists, "Nコードが無いのに取得のボタンがあります").toBe(false);
    },
    {
      keybindings: [OPEN_STATS_KEY],
      // 投稿ページの URL にも Nコードを入れない（URL からも Nコードを拾う作りなので）
      prepareWork: writeLedgerBeforeLaunch(() =>
        ledger({ sites: [{ site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/" }], profiles: [] })
      ),
    }
  );
});

/* ── 4. 順位の推移のグラフ ── */

interface RankChartView {
  title: boolean;
  lines: Array<{ cls: string }>;
  legend: string[];
  dots: Array<{ title: string; cy: number; cls: string }>;
  text: string;
}

async function rankChart(frame: Frame, site: string): Promise<RankChartView> {
  return frame.evaluate((key) => {
    const page = document.querySelector(`#page-site-${key}`) as HTMLElement | null;
    return {
      title: (page?.textContent ?? "").includes("順位の推移（上ほど上位）"),
      lines: Array.from(page?.querySelectorAll(".rank-chart polyline.rank-line") ?? []).map((node) => ({
        cls: node.getAttribute("class") ?? "",
      })),
      legend: Array.from(page?.querySelectorAll(".rank-legend .rank-key") ?? []).map((node) => (node.textContent ?? "").trim()),
      dots: Array.from(page?.querySelectorAll(".rank-chart circle.rank-dot") ?? []).map((node) => ({
        title: node.querySelector("title")?.textContent ?? "",
        cy: Number(node.getAttribute("cy")),
        cls: node.getAttribute("class") ?? "",
      })),
      text: page?.textContent ?? "",
    };
  }, site);
}

test("順位の推移は種別ごとに線と凡例が分かれ、API の日間は圏外の所で線が切れ、1位側が上に描かれ、順位の無いカクヨムのタブには案内の1行が出る", async () => {
  await withVsCode(
    "順位の推移のグラフ",
    [EPISODE],
    async (session) => {
      const frame = await openStats(session.page, 3);
      await frame.locator('.tab[data-page="site-narou"]').click();
      let chart: RankChartView | undefined;
      await waitUntil(async () => ((chart = await rankChart(frame, "narou")).lines.length > 0), "なろうの反応に順位の推移の線が出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（面：${JSON.stringify(chart)}）`);
        }
      );
      const narou = chart as RankChartView;
      expect(narou.title).toBe(true);
      expect(narou.legend, "凡例は種別ごとに1つ（最初に出た順）").toEqual(["日間", "週間"]);
      // 日間は 10-02 と 10-05 の間が圏外で2本、週間は1本
      const daily = narou.lines.filter((line) => line.cls.includes("rank-s0"));
      const weekly = narou.lines.filter((line) => line.cls.includes("rank-s1"));
      expect(daily.length, `日間の線が圏外で切れていません：${JSON.stringify(narou.lines)}`).toBe(2);
      expect(weekly.length, `週間の線：${JSON.stringify(narou.lines)}`).toBe(1);
      // 種別ごとに色の組（クラス）が違う
      expect(new Set(narou.lines.map((line) => line.cls)).size).toBe(2);
      // 1位側が上：日間の10位の点は50位の点より上（cy が小さい）
      const dot = (rank: number) => narou.dots.find((entry) => entry.cls.includes("rank-s0") && entry.title.endsWith(`  ${rank}位`));
      const top = dot(10);
      const bottom = dot(50);
      expect(top && bottom, `日間の点が見つかりません：${JSON.stringify(narou.dots)}`).toBeTruthy();
      expect((top as { cy: number }).cy).toBeLessThan((bottom as { cy: number }).cy);
      // 圏外の日（10-03 の日間）には点が無い
      expect(narou.dots.some((entry) => entry.cls.includes("rank-s0") && entry.title.includes("2026-10-03"))).toBe(false);
      expect(narou.text).toContain("線が切れている所は、その種別で順位が無かった（圏外）。");

      // 順位の無いカクヨム：グラフの代わりに1行
      await frame.locator('.tab[data-page="site-kakuyomu"]').click();
      const kakuyomu = await rankChart(frame, "kakuyomu");
      expect(kakuyomu.lines.length).toBe(0);
      expect(kakuyomu.text).toContain("「ランキング記録」で順位を残すと、ここに推移が出ます。");
    },
    {
      keybindings: [OPEN_STATS_KEY],
      prepareWork: writeLedgerBeforeLaunch(threeSitesLedger),
    }
  );
});

/* ── 5. 順位のお祝い ── */

/** 昨日の日時（手の記録の recordedAt。お祝いは7日より前の順位を祝わないので、近い日に置く） */
function yesterdayIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

/** カクヨムだけを登録し、昨日の週間30位を記録した台帳 */
function kakuyomuWeeklyLedger(): Record<string, unknown> {
  return ledger({
    sites: [KAKUYOMU_SITE],
    profiles: [{ site: "kakuyomu", workId: KAKUYOMU_ID }],
    rankings: [{ site: "kakuyomu", recordedAt: yesterdayIso(), board: "週間", rank: 30 }],
  });
}

/** 作品の右クリック「ランキング記録」で、カクヨムの週間に順位を入れる */
async function recordWeekly(page: Page, rank: string): Promise<void> {
  await treeContextMenu(page, E2E_WORK_TITLE, "ランキング記録");
  await waitForQuickInput(page, "のランキングを記録");
  await pickQuickPickRow(page, "カクヨム");
  await waitForQuickInput(page, "カクヨム のランキングの種別");
  await pickQuickPickRow(page, "週間");
  await waitForQuickInput(page, "カクヨム の週間の順位");
  await answerInput(page, rank);
  await waitForQuickInput(page, "メモ（任意）");
  await answerInput(page, "");
  await waitQuickInputClosed(page, "ランキング記録が閉じる");
}

const RISE_NOTICE = `「${E2E_WORK_TITLE}」がカクヨムの週間で30位から12位に上がりました！`;

async function riseNotices(page: Page): Promise<string[]> {
  return (await notificationTexts(page)).filter((text) => text.includes("位に上がりました！") || text.includes("位に入りました！"));
}

async function bannerText(frame: Frame): Promise<string> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll(".celebrate-banner"))
      .map((node) => node.textContent ?? "")
      .join("\n")
  );
}

test("ランキング記録で下がった順位では何も出ず、上がった順位で「30位から12位に上がりました！」が1回出て開いている執筆統計に札が出て、同じ記録をもう一度入れても二度は出ない", async () => {
  await withVsCode(
    "順位のお祝い（開いているとき）",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      const frame = await openStats(page, 1);
      /*
        見本の「昨日の週間30位」は、まだ執筆統計で見せていない初めての順位なので、開いたときに
        1回だけ「30位に入りました」の札が出る（閉じていた間の順位を次に開いたときに見せる作り）。
        それが消えてから、記録したときの動きを見る
      */
      let opening = "";
      await waitUntil(async () => (opening = await bannerText(frame)).includes("30位に入りました"), "開いたときに、まだ見せていない30位の札が出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（札：${JSON.stringify(opening)}）`);
        }
      );
      await waitUntil(async () => (await bannerText(frame)) === "", "開いたときの札が消える", 15_000);
      await clearNotifications(page);

      // 下がった順位（30位→40位）では何も出ない
      await recordWeekly(page, "40");
      await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("週間 40位 を記録しました")), "40位を記録した知らせが出る", 15_000);
      await holdsFor(async () => (await riseNotices(page)).length === 0 && (await bannerText(frame)) === "", "下がった順位ではお祝いが出ない", 4_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／札：${await bannerText(frame)}）`);
        }
      );
      await clearNotifications(page);

      // 上がった順位（同じ日の書き直しで 12位。前の日の 30位と比べる）
      await recordWeekly(page, "12");
      let seenBanner = "";
      await waitUntil(
        async () => {
          const banner = await bannerText(frame);
          if (banner) seenBanner = banner;
          return (await riseNotices(page)).includes(RISE_NOTICE) && seenBanner.includes("おめでとうございます");
        },
        "「30位から12位に上がりました！」の知らせと、執筆統計の「おめでとうございます」の札が出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／札：${JSON.stringify(seenBanner)}）`);
      });
      expect((await riseNotices(page)).filter((text) => text === RISE_NOTICE).length, "同じお祝いの知らせが2つ出ています").toBe(1);
      await clearNotifications(page);
      // 札が消えるまで待つ（4.5秒で薄れ、0.8秒後に消える）
      await waitUntil(async () => (await bannerText(frame)) === "", "お祝いの札が消える", 15_000);

      // 同じ記録（12位）をもう一度入れても、二度は出ない
      await recordWeekly(page, "12");
      await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("週間 12位 を記録しました")), "12位を記録した知らせが出る", 15_000);
      await holdsFor(async () => (await riseNotices(page)).length === 0 && (await bannerText(frame)) === "", "同じ記録では二度お祝いが出ない", 4_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／札：${await bannerText(frame)}）`);
        }
      );
    },
    {
      ...SIDEBAR_LAUNCH,
      keybindings: [...SIDEBAR_LAUNCH.keybindings, OPEN_STATS_KEY],
      prepareWork: writeLedgerBeforeLaunch(kakuyomuWeeklyLedger),
    }
  );
}, 240_000);

test("執筆統計を閉じたまま上がった順位を記録すると、次に開いたとき1回だけ「おめでとうございます」の札が出て、開き直すともう出ない", async () => {
  await withVsCode(
    "順位のお祝い（閉じていたとき）",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      await clearNotifications(page);
      await recordWeekly(page, "12");
      await waitUntil(async () => (await riseNotices(page)).includes(RISE_NOTICE), "上がった知らせが出る", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });

      // 開くと札が1回出る
      const frame = await openStats(page, 1);
      let seen = "";
      await waitUntil(async () => (seen = await bannerText(frame)).includes("おめでとうございます"), "開いたときにお祝いの札が出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（札：${JSON.stringify(seen)}）`);
        }
      );
      expect(seen, `札にどの順位かが書かれていません：${seen}`).toContain("12");
      await waitUntil(async () => (await bannerText(frame)) === "", "お祝いの札が消える", 15_000);
      // 見せ終えた印が保管庫へ届く間を置く
      await page.waitForTimeout(1_500);
      await closeStats(page);

      // 開き直すともう出ない
      const again = await openStats(page, 1);
      await holdsFor(async () => (await bannerText(again)) === "", "開き直したら、同じお祝いはもう出ない", 5_000);
    },
    {
      ...SIDEBAR_LAUNCH,
      keybindings: [...SIDEBAR_LAUNCH.keybindings, OPEN_STATS_KEY, CLOSE_EDITOR_KEY],
      prepareWork: writeLedgerBeforeLaunch(kakuyomuWeeklyLedger),
    }
  );
}, 240_000);
