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
 * 5. 順位のお祝い：「ランキング記録」で下がった順位では何も出ず、自己最高より良い順位を記録すると
 *    「「〈作品〉」がカクヨムの週間で自己最高の30位を抜いて12位になりました！」が1回出て、開いている執筆統計に
 *    「おめでとうございます」の札が出る。同じ記録をもう一度入れても二度は出ない。閉じていた作品では
 *    次に開いたときに1回だけ札が出る（開き直すともう出ない）
 * 6. 順位のお祝いの規模：初めての順位（12位）は「12位に入りました！」と風船だけ（4個）、10位以内（5位）は
 *    風船8個に花火が足され、1位は風船20個と、10位以内より多い火花。10位より下でも50位以上上がれば
 *    （自己最高の80位を抜いて25位）風船8個と花火（区切りは `core/rankCelebrations.ts`）。
 *    絵は面の中の描く呼び出しを数えて読む（良し悪しは見ない）。「アニメーションを減らす」
 *    （prefers-reduced-motion: reduce。Playwright の emulateMedia で写す）のときは絵が出ず札だけ
 *
 * **作者の目に残すもの**：幅 360px での折り返し・暗いテーマで読めるか・線の色の見分け・風船と花火の
 * 見た目（動きの良し悪し）・OS の設定そのもので「アニメーションを減らす」が画面に届くか。本物のなろうの API は呼ばない（取得のボタンは押さない）。
 * **AI は呼ばない。**
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { NAROU_GUIDELINE_URL } from "../../src/core/narouApi";
import { NAROU_API_CONSENT_KEY } from "../../src/core/narouApiGate";
import { RANK_BALLOONS } from "../../src/core/rankCelebrations";
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

      /*
        なろうの反応を見たまま閉じて開き直すと、なろうの反応で開く。
        **覚えの便が届く間を置いてから閉じる。** タブを移ると面が拡張機能へ「選んだ」を送り（`tabSelected`）、
        拡張機能が保管庫へ書く。矢印キーの直後に閉じると、その便が届く前に面が消え、ひとつ前の「概要」を
        覚えたまま開き直すことがあった（2026-11-02、まとめて走らせて1回）。便の到着は画面の外から見えないので、
        お祝いの件（見せ終えた印）と同じく間を置く。作者の手はこの速さで閉じない
      */
      await page.waitForTimeout(1_500);
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

/**
 * 作品の右クリック「投稿と読者の反応…」→「ランキング記録」で、カクヨムの週間に順位を入れる。
 * 投稿まわりの6つは 0.122.0 で右クリックの入口1つにまとめた（作者の判断 2026-11-02。
 * `core/postingMenu.ts`）。右クリックで指した作品のまま、作品を選び直させずに進むことも見る
 */
async function recordWeekly(page: Page, rank: string, options: { typeBoard?: boolean } = {}): Promise<void> {
  await treeContextMenu(page, E2E_WORK_TITLE, "投稿と読者の反応…");
  await waitForQuickInput(page, `投稿と読者の反応（${E2E_WORK_TITLE}）`);
  await pickQuickPickRow(page, "ランキング記録");
  await waitForQuickInput(page, "のランキングを記録");
  await pickQuickPickRow(page, "カクヨム");
  await waitForQuickInput(page, "カクヨム のランキングの種別");
  // そのサイトに順位がまだ1つも無いと、種別は選ぶ画面でなく打ち込む欄で訊かれる
  if (options.typeBoard) await answerInput(page, "週間");
  else await pickQuickPickRow(page, "週間");
  await waitForQuickInput(page, "カクヨム の週間の順位");
  await answerInput(page, rank);
  await waitForQuickInput(page, "メモ（任意）");
  await answerInput(page, "");
  await waitQuickInputClosed(page, "ランキング記録が閉じる");
}

const RISE_NOTICE = `「${E2E_WORK_TITLE}」がカクヨムの週間で自己最高の30位を抜いて12位になりました！`;

async function riseNotices(page: Page): Promise<string[]> {
  return (await notificationTexts(page)).filter((text) => ["位に入りました！", "位になりました！", "続きました！"].some((tail) => text.includes(tail)));
}

async function bannerText(frame: Frame): Promise<string> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll(".celebrate-banner"))
      .map((node) => node.textContent ?? "")
      .join("\n")
  );
}

test("ランキング記録で下がった順位では何も出ず、自己最高を抜いた順位で「自己最高の30位を抜いて12位になりました！」が1回出て開いている執筆統計に札が出て、同じ記録をもう一度入れても二度は出ない", async () => {
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

      // 自己最高を抜いた順位（同じ日の書き直しで 12位。それまでの自己最高の 30位と比べる）
      await recordWeekly(page, "12");
      let seenBanner = "";
      await waitUntil(
        async () => {
          const banner = await bannerText(frame);
          if (banner) seenBanner = banner;
          return (await riseNotices(page)).includes(RISE_NOTICE) && seenBanner.includes("おめでとうございます");
        },
        "「自己最高の30位を抜いて12位になりました！」の知らせと、執筆統計の「おめでとうございます」の札が出る",
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

/* ── 6. 順位のお祝いの規模（風船・花火が出たか）と「アニメーションを減らす」 ── */

/** カクヨムだけを登録し、順位はまだ1つも無い台帳 */
function kakuyomuNoRankLedger(): Record<string, unknown> {
  return ledger({ sites: [KAKUYOMU_SITE], profiles: [{ site: "kakuyomu", workId: KAKUYOMU_ID }] });
}

interface CelebrationProbe {
  /** お祝いの絵の層（`canvas.celebrate-layer`）が足された回数 */
  layers: number;
  /** 描いた1コマの数 */
  frames: number;
  /** 1コマで描いた風船の数の最大（風船は1つにつき楕円を2回描く：本体と光） */
  maxBalloons: number;
  /** 花火の火花を描いた回数（火花だけが円 `arc` で描かれる） */
  sparks: number;
}

interface ProbeStore {
  layers: number;
  frames: Array<{ ellipses: number; arcs: number }>;
}

/**
 * 執筆統計の面の中で、お祝いの絵の描き方を数える（試験の側で面に差し込む。製品は変えない）。
 *
 * 絵の良し悪しは見ない。「風船が上がったか」「花火が上がったか」「何個か」だけを、描く呼び出しの数で読む。
 * お祝いの層（`.celebrate-layer`）の絵だけを数える——グラフなど、ほかの絵は数えない
 */
async function installCelebrationProbe(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const host = window as unknown as { __celebrationProbe?: ProbeStore };
    if (host.__celebrationProbe) return;
    const probe: ProbeStore = { layers: 0, frames: [] };
    host.__celebrationProbe = probe;
    const isCelebration = (ctx: CanvasRenderingContext2D) => ctx.canvas.classList.contains("celebrate-layer");
    const proto = CanvasRenderingContext2D.prototype;
    const clearRect = proto.clearRect;
    const ellipse = proto.ellipse;
    const arc = proto.arc;
    // 1コマの始まりは clearRect（製品の frame() は毎コマ最初に消す）
    proto.clearRect = function (this: CanvasRenderingContext2D, ...args: Parameters<CanvasRenderingContext2D["clearRect"]>) {
      if (isCelebration(this)) probe.frames.push({ ellipses: 0, arcs: 0 });
      return clearRect.apply(this, args);
    };
    proto.ellipse = function (this: CanvasRenderingContext2D, ...args: Parameters<CanvasRenderingContext2D["ellipse"]>) {
      const current = probe.frames[probe.frames.length - 1];
      if (current && isCelebration(this)) current.ellipses += 1;
      return ellipse.apply(this, args);
    };
    proto.arc = function (this: CanvasRenderingContext2D, ...args: Parameters<CanvasRenderingContext2D["arc"]>) {
      const current = probe.frames[probe.frames.length - 1];
      if (current && isCelebration(this)) current.arcs += 1;
      return arc.apply(this, args);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node instanceof HTMLCanvasElement && node.classList.contains("celebrate-layer")) probe.layers += 1;
        });
      }
    }).observe(document.body, { childList: true });
  });
}

async function readCelebrationProbe(frame: Frame): Promise<CelebrationProbe> {
  return frame.evaluate(() => {
    const probe = (window as unknown as { __celebrationProbe: ProbeStore }).__celebrationProbe;
    return {
      layers: probe.layers,
      frames: probe.frames.length,
      maxBalloons: probe.frames.reduce((max, one) => Math.max(max, Math.floor(one.ellipses / 2)), 0),
      sparks: probe.frames.reduce((sum, one) => sum + one.arcs, 0),
    };
  });
}

async function resetCelebrationProbe(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const probe = (window as unknown as { __celebrationProbe: ProbeStore }).__celebrationProbe;
    probe.layers = 0;
    probe.frames.length = 0;
  });
}

/** 順位を記録し、`notice` の知らせと札が出て、お祝いの絵が描き終わる（層が消える）まで待って、描き方を返す */
async function recordAndWatch(
  page: Page,
  frame: Frame,
  rank: string,
  notice: string,
  options: { typeBoard?: boolean } = {}
): Promise<{ banner: string; probe: CelebrationProbe }> {
  await clearNotifications(page);
  await resetCelebrationProbe(frame);
  await recordWeekly(page, rank, options);
  let banner = "";
  await waitUntil(
    async () => {
      const now = await bannerText(frame);
      if (now) banner = now;
      return (await riseNotices(page)).includes(notice) && banner.includes("おめでとうございます");
    },
    `「${notice}」の知らせと、執筆統計の「おめでとうございます」の札が出る`,
    15_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／札：${JSON.stringify(banner)}）`);
  });
  // 絵は4.5秒で消える。札（4.5秒＋0.8秒）が消えれば、絵も描き終わっている
  await waitUntil(async () => (await bannerText(frame)) === "" && (await frame.locator("canvas.celebrate-layer").count()) === 0, "お祝いの札と絵が消える", 20_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（描き方：${JSON.stringify(await readCelebrationProbe(frame))}）`);
    }
  );
  return { banner, probe: await readCelebrationProbe(frame) };
}

test("初めての順位を記録すると「12位に入りました！」が出て執筆統計に風船だけが上がり、10位以内に入ると風船に花火が足され、1位では風船も火花も増える", async () => {
  await withVsCode(
    "順位のお祝いの規模",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      const frame = await openStats(page, 1);
      await installCelebrationProbe(frame);

      // 初めての順位（12位。10位より下）：風船だけ
      const first = await recordAndWatch(page, frame, "12", `「${E2E_WORK_TITLE}」がカクヨムの週間で12位に入りました！`, { typeBoard: true });
      expect(first.probe.layers, `お祝いの絵：${JSON.stringify(first.probe)}`).toBe(1);
      expect(first.probe.frames, `お祝いの絵が動いていません：${JSON.stringify(first.probe)}`).toBeGreaterThan(5);
      expect(first.probe.maxBalloons, `風船の数：${JSON.stringify(first.probe)}`).toBe(RANK_BALLOONS.small);
      expect(first.probe.sparks, `10位より下なのに花火が上がりました：${JSON.stringify(first.probe)}`).toBe(0);

      // 同じ日の書き直しで5位（10位以内）：風船に花火が足される
      const top10 = await recordAndWatch(page, frame, "5", `「${E2E_WORK_TITLE}」がカクヨムの週間で5位に入りました！`);
      expect(top10.probe.layers, `お祝いの絵：${JSON.stringify(top10.probe)}`).toBe(1);
      expect(top10.probe.maxBalloons, `風船の数：${JSON.stringify(top10.probe)}`).toBe(RANK_BALLOONS.fireworks);
      expect(top10.probe.sparks, `10位以内なのに花火が上がりません：${JSON.stringify(top10.probe)}`).toBeGreaterThan(0);

      // 1位：大きな花火（風船も火花も増える）
      const grand = await recordAndWatch(page, frame, "1", `「${E2E_WORK_TITLE}」がカクヨムの週間で1位に入りました！`);
      expect(grand.probe.layers, `お祝いの絵：${JSON.stringify(grand.probe)}`).toBe(1);
      expect(grand.probe.maxBalloons, `風船の数：${JSON.stringify(grand.probe)}`).toBe(RANK_BALLOONS.grand);
      expect(grand.probe.sparks, `1位の火花が10位以内より多くありません：${JSON.stringify({ top10: top10.probe, grand: grand.probe })}`).toBeGreaterThan(top10.probe.sparks);
    },
    {
      ...SIDEBAR_LAUNCH,
      keybindings: [...SIDEBAR_LAUNCH.keybindings, OPEN_STATS_KEY],
      prepareWork: writeLedgerBeforeLaunch(kakuyomuNoRankLedger),
    }
  );
}, 240_000);

/** カクヨムだけを登録し、昨日の週間80位を記録した台帳（50位以上の上昇を作る） */
function kakuyomuWeekly80Ledger(): Record<string, unknown> {
  return ledger({
    sites: [KAKUYOMU_SITE],
    profiles: [{ site: "kakuyomu", workId: KAKUYOMU_ID }],
    rankings: [{ site: "kakuyomu", recordedAt: yesterdayIso(), board: "週間", rank: 80 }],
  });
}

test("10位より下でも50位以上上がると「自己最高の80位を抜いて25位になりました！」が出て、執筆統計に風船と花火が上がる", async () => {
  await withVsCode(
    "順位のお祝い（50位以上の上昇）",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      const frame = await openStats(page, 1);
      // 見本の「昨日の80位」は、開いたときに1回だけ札が出る（まだ見せていない初めての順位）。消えてから記録する
      await waitUntil(async () => (await bannerText(frame)).includes("80位に入りました"), "開いたときに、まだ見せていない80位の札が出る", 15_000);
      await waitUntil(async () => (await bannerText(frame)) === "" && (await frame.locator("canvas.celebrate-layer").count()) === 0, "開いたときの札と絵が消える", 20_000);
      await installCelebrationProbe(frame);
      const rise = await recordAndWatch(page, frame, "25", `「${E2E_WORK_TITLE}」がカクヨムの週間で自己最高の80位を抜いて25位になりました！`);
      expect(rise.probe.layers, `お祝いの絵：${JSON.stringify(rise.probe)}`).toBe(1);
      expect(rise.probe.maxBalloons, `風船の数：${JSON.stringify(rise.probe)}`).toBe(RANK_BALLOONS.fireworks);
      expect(rise.probe.sparks, `50位以上上がったのに花火が上がりません：${JSON.stringify(rise.probe)}`).toBeGreaterThan(0);
    },
    {
      ...SIDEBAR_LAUNCH,
      keybindings: [...SIDEBAR_LAUNCH.keybindings, OPEN_STATS_KEY],
      prepareWork: writeLedgerBeforeLaunch(kakuyomuWeekly80Ledger),
    }
  );
}, 240_000);

test("「アニメーションを減らす」（prefers-reduced-motion: reduce）のときは、1位に入っても風船・花火の絵は出ず「おめでとうございます」の札だけが出る", async () => {
  await withVsCode(
    "順位のお祝い（動きを減らす）",
    [EPISODE],
    async (session) => {
      const { page } = session;
      // OS の「アニメーションを減らす」は、画面の中では prefers-reduced-motion として届く。ここではそれを写す
      await page.emulateMedia({ reducedMotion: "reduce" });
      await showSidebar(page, E2E_WORK_TITLE);
      const frame = await openStats(page, 1);
      expect(await frame.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches), "執筆統計の面に「動きを減らす」が届いていません").toBe(true);
      await installCelebrationProbe(frame);
      const seen = await recordAndWatch(page, frame, "1", `「${E2E_WORK_TITLE}」がカクヨムの週間で1位に入りました！`, { typeBoard: true });
      expect(seen.banner).toContain("1位");
      expect(seen.probe.layers, `動きを減らすのに絵が出ました：${JSON.stringify(seen.probe)}`).toBe(0);
      expect(seen.probe.frames).toBe(0);
    },
    {
      ...SIDEBAR_LAUNCH,
      keybindings: [...SIDEBAR_LAUNCH.keybindings, OPEN_STATS_KEY],
      prepareWork: writeLedgerBeforeLaunch(kakuyomuNoRankLedger),
    }
  );
}, 240_000);
