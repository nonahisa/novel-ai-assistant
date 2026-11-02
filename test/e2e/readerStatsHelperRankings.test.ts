/**
 * ヘルパー（統合小説執筆環境ヘルパー 0.19.0）がランキングの画面で読んだ順位を「まとめて渡す」で受け取ったとき、
 * VS Code の側で起きること（画面の自動テスト、設計書6.79.7・6.3.9・6.113。実機確認リストの 0.121.0 の2項目
 * 「ヘルパー 0.19.0 でカクヨムのランキング…」「ヘルパーから届いた順位が前の日より上がった…」の、
 * **受け取ってから先**を機械へ移した。2026-11-03 リーダーの指示）。
 *
 * 見張ること：
 * 1. 順位だけの束（カクヨムの週間異世界ファンタジーの長編ランキング 112位）を取り込みの合図で受けると、
 *    「順位 1件を取り込みました：「〈作品〉」順位1件。」が出る。`設定/投稿状態.json` の `rankings` に
 *    `"source": "helper"`・`boardLabel`・`span` の行が入り、執筆統計の「カクヨムの反応」の順位の表に
 *    種別が画面の見出しのまま・メモ「ヘルパーがランキングの画面から読み取り」の行が出て、順位の推移の
 *    凡例にその見出しの線が出る。同じ束をもう一度渡すと「順位は、すでに取り込んだものと同じでした」で
 *    行は増えない
 * 2. 管理画面の数（カクヨムの封筒1画面）とアルファポリスの HOTランキングの順位を同じ束で渡すと、
 *    「読者の反応 1画面と順位 1件を取り込みました」が出て、「アルファの反応」の順位の表に「HOTランキング」の行
 * 3. お祝い（**0.122.4 の決まり**。`core/rankCelebrations.ts`）：前の日までにヘルパーから届いていた順位に
 *    続けて、1つの束で4つの区分の順位を渡すと、それぞれ
 *    「自己最高の30位を抜いて12位になりました！」（自己最高を抜いた）・「1位が2日続きました！」（日間の1位が続いた）・
 *    「1位に戻りました！」（切れたあとに1位へ戻った）・「8位に入りました！」（初めて入った）の知らせが出て、
 *    執筆統計を開くと「おめでとうございます」の札とお祝いの絵の層が出る
 * 4. 区分が7本以上：8本の線がある作品で、グラフには直近に順位のある6本だけが描かれ（届いたばかりの区分を含む）、
 *    下に「ほかに2本の線（…）は、下の順位の表で見られます。」が出て、描かれない2本も順位の表には行がある
 *
 * 届け方：束はクリップボードへ置き、合図 `vscode://nonahisa.novel-ai-assistant/import-reader-stats` は
 * テスト用の VS Code の中の「Developer: Open URL」で開く（`support/helperRankingFixture.ts`。OS には開かせない）。
 * クリップボードは作者の OS のものと同じなので、件の前の中身を控えて戻す。
 *
 * **作者の目・本物のサイトに残すもの**：ヘルパーが本物のカクヨム・アルファポリスのランキングの画面から順位を
 * 読めるか（画面の作りが変わっていないか）・ヘルパーの「まとめて渡す」を押して本物の vscode:// の受け手から
 * VS Code が前に出るか・風船と花火の見た目（規模ごとの風船の数・花火は writingStatsSiteTabs の件が数えている）。
 * **AI は呼ばない。**
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { rankEventNotice, type RankEvent } from "../../src/core/rankCelebrations";
import { parseReaderStatsPaste, buildReaderStatsEnvelope, type ReaderStatsRanking } from "../../src/core/readerStatsEnvelope";
import { routeReaderStatsRanking } from "../../src/core/readerStatsHelperLink";
import type { PostingLedger } from "../../src/models/posting";
import { readJsonWhenPresent } from "./support/fileSettle";
import {
  HELPER_LINK_LAUNCH,
  handOverFromHelper,
  helperBundleText,
  helperLedgerRanking,
  helperRanking,
  keepClipboard,
  localDay,
  postingLedger,
} from "./support/helperRankingFixture";
import { describeNotices, recordedNotices, waitForNotice } from "./support/noticeRecord";
import { statsFrame } from "./support/statsFixture";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = { name: "001_はじまり.txt", text: "一行目の文。\n" };

const KAKUYOMU_ID = "16816927861924296900";
const ALPHAPOLIS_ID = "123456789";
const KAKUYOMU_SITE = { site: "kakuyomu", newEpisodeUrl: `https://kakuyomu.jp/my/works/${KAKUYOMU_ID}/episodes/new` };
const ALPHAPOLIS_SITE = { site: "alphapolis", newEpisodeUrl: `https://www.alphapolis.co.jp/mypage/novel/save_episode/${ALPHAPOLIS_ID}` };
const KAKUYOMU_PROFILE = { site: "kakuyomu", workId: KAKUYOMU_ID };
const ALPHAPOLIS_PROFILE = { site: "alphapolis", workId: ALPHAPOLIS_ID };

/** 製品が順位の行に書くメモ（`rankingRecordFromHelper`） */
const HELPER_NOTE = "ヘルパーがランキングの画面から読み取り";

/** カクヨムの区分（ヘルパーが URL から組む鍵と、画面の見出し） */
const FANTASY_WEEKLY = { board: "rankings/fantasy/weekly/long", boardLabel: "週間異世界ファンタジーの長編ランキング", span: "weekly", genre: "異世界ファンタジー" } as const;
const ALL_DAILY = { board: "rankings/all/daily/long", boardLabel: "日間総合の長編ランキング", span: "daily" } as const;
const SF_DAILY = { board: "rankings/sf/daily/long", boardLabel: "日間SFの長編ランキング", span: "daily", genre: "SF" } as const;
const LOVE_WEEKLY = { board: "rankings/love_story/weekly/long", boardLabel: "週間恋愛の長編ランキング", span: "weekly", genre: "恋愛" } as const;

function kakuyomuRanking(board: { board: string; boardLabel: string; span: ReaderStatsRanking["span"]; genre?: string }, rank: number, date: string): ReaderStatsRanking {
  return helperRanking({ workId: KAKUYOMU_ID, title: "架空の自分の題", ...board, rank, date });
}

function writeLedgerBeforeLaunch(body: () => Record<string, unknown>): LaunchOptions["prepareWork"] {
  return async ({ workFolder }) => {
    await mkdir(path.join(workFolder, "設定"), { recursive: true });
    await writeFile(path.join(workFolder, "設定", "投稿状態.json"), JSON.stringify(body(), null, 2), "utf8");
  };
}

function ledgerPath(session: E2ESession): string {
  return path.join(session.workFolder, "設定", "投稿状態.json");
}

async function readLedger(session: E2ESession): Promise<PostingLedger> {
  return readJsonWhenPresent<PostingLedger>(ledgerPath(session));
}

/**
 * **見本の束が製品の関所を通る形か**を、VS Code を起こす前に確かめる。崩れていると、走った機械では
 * 「取り込まれない」とだけ見えて、見本が悪いのか製品が悪いのかが文で分からない
 */
function expectBundleRoutes(bundle: string, ledger: Record<string, unknown>, wantRankings: number): void {
  const parsed = parseReaderStatsPaste(bundle);
  expect(parsed.ok && parsed.kind === "bundle", `見本の束が読めません：${JSON.stringify(parsed)}`).toBe(true);
  if (!parsed.ok || parsed.kind !== "bundle") return;
  const rankings = parsed.bundle.rankings ?? [];
  expect(rankings.length).toBe(wantRankings);
  for (const item of rankings) {
    expect(item.result.ok, `見本の順位の${item.position}件目が読めません：${JSON.stringify(item.result)}`).toBe(true);
    if (!item.result.ok) continue;
    const route = routeReaderStatsRanking(item.result.ranking, [{ id: "見本", ledger: ledger as unknown as PostingLedger }]);
    expect(route, `見本の順位の${item.position}件目が作品に決まりません`).toEqual({ kind: "work", id: "見本" });
  }
  for (const item of parsed.bundle.items) {
    expect(item.result.ok, `見本の画面の${item.position}件目が読めません：${JSON.stringify(item.result)}`).toBe(true);
  }
}

/* ── 執筆統計の読み取り（writingStatsSiteTabs と同じ DOM に頼る） ── */

const OPEN_STATS_KEY = { key: "ctrl+alt+shift+u", command: "novelai.showWritingStats" };
const OPEN_STATS_PRESS = "Control+Alt+Shift+KeyU";

async function openStats(page: Page, wantSiteTabs: number): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_STATS_PRESS);
  let frame: Frame | undefined;
  await waitUntil(async () => (frame = await statsFrame(page)) !== undefined, "執筆統計の画面が開く", 30_000);
  const found = frame as Frame;
  await waitUntil(async () => (await found.locator(".tab[data-site]").count()) === wantSiteTabs, `サイトのタブが ${wantSiteTabs} つ出る`, 20_000);
  return found;
}

interface SiteRankView {
  /** 順位の表の行（日時・種別・順位・メモ） */
  rows: Array<{ when: string; board: string; rank: string; note: string }>;
  legend: string[];
  /** 描かれた点の見出し（`title` の字。種別の名前を含む） */
  dotTitles: string[];
  text: string;
}

/** サイトのタブの、順位のグラフと順位の表（列が「日時・種別・順位・メモ」の表） */
async function siteRanks(frame: Frame, site: string): Promise<SiteRankView> {
  return frame.evaluate((key) => {
    const page = document.querySelector(`#page-site-${key}`) as HTMLElement | null;
    const tables = Array.from(page?.querySelectorAll("table") ?? []).filter((table) => {
      const head = Array.from(table.querySelectorAll("thead th")).map((th) => (th.textContent ?? "").trim());
      return head.join("|") === "日時|種別|順位|メモ";
    });
    const rows = tables.flatMap((table) =>
      Array.from(table.querySelectorAll("tbody tr")).map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim());
        return { when: cells[0] ?? "", board: cells[1] ?? "", rank: cells[2] ?? "", note: cells[3] ?? "" };
      })
    );
    return {
      rows,
      legend: Array.from(page?.querySelectorAll(".rank-legend .rank-key") ?? []).map((node) => (node.textContent ?? "").trim()),
      dotTitles: Array.from(page?.querySelectorAll(".rank-chart circle.rank-dot title") ?? []).map((node) => node.textContent ?? ""),
      text: page?.textContent ?? "",
    };
  }, site);
}

async function showSiteTab(frame: Frame, site: string): Promise<void> {
  await frame.locator(`.tab[data-page="site-${site}"]`).click();
  await waitUntil(
    async () => frame.evaluate((key) => document.querySelector(`#page-site-${key}.active`) !== null, site),
    `「${site}」の反応のタブが前に出る`,
    10_000
  );
}

/** 順位の表に、その種別・順位・メモの行が出るまで待つ */
async function waitRankRow(frame: Frame, site: string, board: string, rank: number, label: string): Promise<SiteRankView> {
  let view: SiteRankView | undefined;
  await waitUntil(
    async () => {
      view = await siteRanks(frame, site);
      return view.rows.some((row) => row.board === board && row.rank === String(rank) && row.note === HELPER_NOTE);
    },
    label,
    20_000
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}（順位の表：${JSON.stringify(view?.rows)}／凡例：${JSON.stringify(view?.legend)}）`);
  });
  return view as SiteRankView;
}

const LAUNCH_BASE = {
  settings: HELPER_LINK_LAUNCH.settings,
  keybindings: [...HELPER_LINK_LAUNCH.keybindings, OPEN_STATS_KEY],
};

/* ── 1. 順位だけの束：知らせ・台帳・表・グラフ・同じ束で増えない ── */

test("ヘルパーが渡したカクヨムのランキングの順位を取り込むと「順位 1件を取り込みました」が出て、台帳に source helper の行・執筆統計の順位の表に見出しのままの種別とメモの行・グラフにその線が出て、同じ束をもう一度渡しても行は増えない", async () => {
  const ranking = kakuyomuRanking(FANTASY_WEEKLY, 112, localDay(0));
  const bundle = helperBundleText({ rankings: [ranking] });
  const ledger = (): Record<string, unknown> => postingLedger({ sites: [KAKUYOMU_SITE], profiles: [KAKUYOMU_PROFILE] });
  expectBundleRoutes(bundle, ledger(), 1);

  await withVsCode(
    "ヘルパーの順位の取り込み",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await keepClipboard(session, async () => {
        await clearNotifications(page);

        // ── 渡す：知らせの文（取り込んだ件数と作品名） ──
        const since = Date.now();
        await handOverFromHelper(session, bundle);
        const notice = await waitForNotice(
          session,
          (message) => message.includes("順位 1件を取り込みました"),
          "「順位 1件を取り込みました」の知らせ",
          { since }
        );
        expect(notice).toContain(`順位 1件を取り込みました：「${E2E_WORK_TITLE}」順位1件。`);
        // 順位だけの束なので「読者の反応」とは言わない
        expect(notice, "順位だけの束なのに読者の反応と言っています").not.toContain("読者の反応");

        // ── ファイル：台帳の rankings の新しい行 ──
        let saved: PostingLedger | undefined;
        await waitUntil(async () => ((saved = await readLedger(session)).rankings ?? []).length === 1, "台帳に順位の行が1つ入る", 15_000).catch(
          (error: unknown) => {
            throw new Error(`${String(error)}（台帳の順位：${JSON.stringify(saved?.rankings)}）`);
          }
        );
        const row = (saved as PostingLedger).rankings[0] as unknown as Record<string, unknown>;
        expect(row).toMatchObject({
          site: "kakuyomu",
          source: "helper",
          board: FANTASY_WEEKLY.board,
          boardLabel: FANTASY_WEEKLY.boardLabel,
          span: "weekly",
          genre: FANTASY_WEEKLY.genre,
          rank: 112,
          note: HELPER_NOTE,
          recordedAt: `${ranking.date}T00:00:00+09:00`,
        });

        // ── 画面：カクヨムの反応の順位の表と、グラフの凡例 ──
        const frame = await openStats(page, 1);
        await showSiteTab(frame, "kakuyomu");
        const view = await waitRankRow(frame, "kakuyomu", FANTASY_WEEKLY.boardLabel, 112, "順位の表に、種別が画面の見出しのまま・メモ「ヘルパーがランキングの画面から読み取り」の112位の行が出る");
        expect(view.legend, `グラフの凡例にその見出しの線がありません：${JSON.stringify(view.legend)}`).toContain(FANTASY_WEEKLY.boardLabel);
        expect(view.dotTitles.some((title) => title.includes("112位")), `グラフに112位の点がありません：${JSON.stringify(view.dotTitles)}`).toBe(true);
        // 区分の鍵（機械向けの名前）は画面に出さない
        expect(view.text, "区分の鍵がそのまま画面に出ています").not.toContain(FANTASY_WEEKLY.board);

        // ── 同じ束をもう一度：取り込んだものと同じ。行は増えない ──
        await clearNotifications(page);
        const againSince = Date.now();
        await handOverFromHelper(session, bundle);
        const again = await waitForNotice(
          session,
          (message) => message.includes("順位は、すでに取り込んだものと同じでした"),
          "同じ束で「順位は、すでに取り込んだものと同じでした」の知らせ",
          { since: againSince }
        );
        expect(again).toContain("記録は変えていません。");
        await holdsFor(async () => ((await readLedger(session)).rankings ?? []).length === 1, "同じ束では台帳の順位の行が増えない", 3_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（台帳の順位：${JSON.stringify((await readLedger(session)).rankings)}）`);
          }
        );
      });
    },
    { ...LAUNCH_BASE, prepareWork: writeLedgerBeforeLaunch(ledger) }
  );
}, 240_000);

/* ── 2. 管理画面の数と順位を同じ束で：アルファポリスの HOTランキング ── */

test("カクヨムの管理画面の数とアルファポリスの HOTランキングの順位を同じ束で渡すと「読者の反応 1画面と順位 1件を取り込みました」が出て、アルファの反応の順位の表に「HOTランキング」の行が出る", async () => {
  const envelope = JSON.parse(
    buildReaderStatsEnvelope({
      site: "kakuyomu",
      workId: KAKUYOMU_ID,
      readAt: new Date().toISOString(),
      title: "架空の自分の題",
      entries: [{ scope: "work", metrics: { pv: 1234 } }],
    })
  ) as unknown;
  const hot = helperRanking({
    site: "alphapolis",
    workId: ALPHAPOLIS_ID,
    title: "架空の自分の題",
    board: "novel/ranking/hot",
    boardLabel: "HOTランキング",
    span: "24h",
    rank: 37,
    date: localDay(0),
  });
  const bundle = helperBundleText({ items: [envelope], rankings: [hot] });
  const ledger = (): Record<string, unknown> =>
    postingLedger({ sites: [KAKUYOMU_SITE, ALPHAPOLIS_SITE], profiles: [KAKUYOMU_PROFILE, ALPHAPOLIS_PROFILE] });
  expectBundleRoutes(bundle, ledger(), 1);

  await withVsCode(
    "ヘルパーの画面と順位を同じ束で",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await keepClipboard(session, async () => {
        await clearNotifications(page);
        const since = Date.now();
        await handOverFromHelper(session, bundle);
        const notice = await waitForNotice(
          session,
          (message) => message.includes("読者の反応 1画面と順位 1件を取り込みました"),
          "「読者の反応 1画面と順位 1件を取り込みました」の知らせ",
          { since }
        );
        expect(notice).toContain(`読者の反応 1画面と順位 1件を取り込みました：「${E2E_WORK_TITLE}」1画面・順位1件`);

        let saved: PostingLedger | undefined;
        await waitUntil(async () => ((saved = await readLedger(session)).rankings ?? []).length === 1, "台帳にアルファポリスの順位の行が入る", 15_000).catch(
          (error: unknown) => {
            throw new Error(`${String(error)}（台帳の順位：${JSON.stringify(saved?.rankings)}）`);
          }
        );
        expect((saved as PostingLedger).rankings[0]).toMatchObject({ site: "alphapolis", source: "helper", board: "novel/ranking/hot", boardLabel: "HOTランキング", span: "24h", rank: 37 });
        expect((saved as PostingLedger).readerStats.some((row) => row.site === "kakuyomu"), "カクヨムの管理画面の数が台帳に入っていません").toBe(true);

        const frame = await openStats(page, 2);
        await showSiteTab(frame, "alphapolis");
        const view = await waitRankRow(frame, "alphapolis", "HOTランキング", 37, "アルファの反応の順位の表に「HOTランキング」37位の行が出る");
        expect(view.legend).toContain("HOTランキング");
      });
    },
    { ...LAUNCH_BASE, prepareWork: writeLedgerBeforeLaunch(ledger) }
  );
}, 240_000);

/* ── 3. お祝い（0.122.4 の決まり）：自己最高・1位の連続・1位に戻った・初めて入った ── */

/** 前の日までにヘルパーから届いていた順位（製品が取り込んだときと同じ形で台帳に置く） */
function celebrationLedger(): Record<string, unknown> {
  return postingLedger({
    sites: [KAKUYOMU_SITE],
    profiles: [KAKUYOMU_PROFILE],
    rankings: [
      // 週間異世界ファンタジー：昨日 30位（自己最高）
      kakuyomuRanking(FANTASY_WEEKLY, 30, localDay(-1)),
      // 日間総合：昨日 1位
      kakuyomuRanking(ALL_DAILY, 1, localDay(-1)),
      // 日間SF：3日前 1位 → 2日前 4位（1位が切れた）
      kakuyomuRanking(SF_DAILY, 1, localDay(-3)),
      kakuyomuRanking(SF_DAILY, 4, localDay(-2)),
      // 週間恋愛：まだ無い（今日初めて入る）
    ].map(helperLedgerRanking),
  });
}

/** 今日届く4件 */
function celebrationRankings(): ReaderStatsRanking[] {
  const today = localDay(0);
  return [
    kakuyomuRanking(FANTASY_WEEKLY, 12, today),
    kakuyomuRanking(ALL_DAILY, 1, today),
    kakuyomuRanking(SF_DAILY, 1, today),
    kakuyomuRanking(LOVE_WEEKLY, 8, today),
  ];
}

/** 製品の文の組み立て（`rankEventNotice`）で、期待する知らせを作る（文を試験の側で写さない） */
function expectedNotice(board: string, rest: Pick<RankEvent, "kind" | "rank" | "previous" | "streak">): string {
  const event: RankEvent = {
    id: "",
    site: "kakuyomu",
    siteLabel: "カクヨム",
    board,
    day: localDay(0),
    size: "small",
    ...rest,
  };
  return rankEventNotice(E2E_WORK_TITLE, event);
}

async function bannerText(frame: Frame): Promise<string> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll(".celebrate-banner"))
      .map((node) => node.textContent ?? "")
      .join("\n")
  );
}

test("ヘルパーから届いた順位で、自己最高を抜いた・日間の1位が続いた・1位に戻った・初めて入ったのそれぞれのお祝いの知らせが出て、執筆統計を開くと「おめでとうございます」の札とお祝いの絵が出る", async () => {
  const bundle = helperBundleText({ rankings: celebrationRankings() });
  expectBundleRoutes(bundle, celebrationLedger(), 4);
  const wanted = [
    expectedNotice(FANTASY_WEEKLY.boardLabel, { kind: "best", rank: 12, previous: 30 }),
    expectedNotice(ALL_DAILY.boardLabel, { kind: "streak", rank: 1, previous: null, streak: { count: 2, unit: "日" } }),
    expectedNotice(SF_DAILY.boardLabel, { kind: "returned", rank: 1, previous: null }),
    expectedNotice(LOVE_WEEKLY.boardLabel, { kind: "entered", rank: 8, previous: null }),
  ];
  // 期待の文が、親の項目に書いた新しい決まりの言い方になっているか（rankEventNotice が変われば、ここで分かる）
  expect(wanted).toEqual([
    `「${E2E_WORK_TITLE}」がカクヨムの週間異世界ファンタジーの長編ランキングで自己最高の30位を抜いて12位になりました！`,
    `「${E2E_WORK_TITLE}」がカクヨムの日間総合の長編ランキングで1位が2日続きました！`,
    `「${E2E_WORK_TITLE}」がカクヨムの日間SFの長編ランキングで1位に戻りました！`,
    `「${E2E_WORK_TITLE}」がカクヨムの週間恋愛の長編ランキングで8位に入りました！`,
  ]);

  await withVsCode(
    "ヘルパーの順位のお祝い",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await keepClipboard(session, async () => {
        await clearNotifications(page);
        const since = Date.now();
        await handOverFromHelper(session, bundle);
        await waitForNotice(session, (message) => message.includes("順位 4件を取り込みました"), "「順位 4件を取り込みました」の知らせ", { since });

        // 4つのお祝いの知らせが、それぞれ1回ずつ出る（右下は3つまでしか並ばないので、知らせの記録で数える）
        for (const notice of wanted) {
          await waitForNotice(session, (message) => message === notice, `お祝いの知らせ「${notice}」`, { since });
        }
        await holdsFor(
          async () => {
            const recorded = (await recordedNotices(session)).filter((entry) => Date.parse(entry.at) >= since - 1_000).map((entry) => entry.message);
            return wanted.every((notice) => recorded.filter((message) => message === notice).length === 1);
          },
          "お祝いの知らせはどれも1回だけ",
          3_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（${await describeNotices(session, since - 1_000)}）`);
        });

        // 執筆統計を開くと、まだ見せていないお祝いの札と絵が出る（札には4つの区分の行）
        const frame = await openStats(page, 1);
        let banner = "";
        let layerSeen = false;
        await waitUntil(
          async () => {
            const now = await bannerText(frame);
            if (now) banner = now;
            if ((await frame.locator("canvas.celebrate-layer").count()) > 0) layerSeen = true;
            return banner.includes("おめでとうございます") && layerSeen;
          },
          "執筆統計を開くと「おめでとうございます」の札とお祝いの絵が出る",
          20_000
        ).catch((error: unknown) => {
          throw new Error(`${String(error)}（札：${JSON.stringify(banner)}／絵の層：${layerSeen}）`);
        });
        for (const label of [FANTASY_WEEKLY.boardLabel, ALL_DAILY.boardLabel, SF_DAILY.boardLabel, LOVE_WEEKLY.boardLabel]) {
          expect(banner, `札に「${label}」の行がありません`).toContain(label);
        }
      });
    },
    { ...LAUNCH_BASE, prepareWork: writeLedgerBeforeLaunch(celebrationLedger) }
  );
}, 240_000);

/* ── 4. 区分が7本以上：グラフは直近の6本、残りは表で ── */

/**
 * 7つの区分の古い順位（**祝う期間の7日より前**。開いたときに7本ぶんの札が出て件が濁らないように）。
 * 最後の日を1日ずつずらし、どれが「直近」かを決まった形にする
 */
const OLD_BOARDS = [
  { board: "rankings/all/weekly/long", boardLabel: "週間総合の長編ランキング", span: "weekly", offset: -20 },
  { board: "rankings/fantasy/daily/long", boardLabel: "日間異世界ファンタジーの長編ランキング", span: "daily", offset: -19 },
  { board: "rankings/action/weekly/long", boardLabel: "週間現代ファンタジーの長編ランキング", span: "weekly", offset: -18 },
  { board: "rankings/sf/weekly/long", boardLabel: "週間SFの長編ランキング", span: "weekly", offset: -17 },
  { board: "rankings/love_story/daily/long", boardLabel: "日間恋愛の長編ランキング", span: "daily", offset: -16 },
  { board: "rankings/romance/weekly/long", boardLabel: "週間ラブコメの長編ランキング", span: "weekly", offset: -15 },
  { board: "rankings/horror/weekly/long", boardLabel: "週間ホラーの長編ランキング", span: "weekly", offset: -14 },
] as const;

test("区分が8本ある作品にヘルパーから新しい区分の順位が届くと、グラフには直近に順位のある6本だけが描かれ、下に「ほかに2本の線（…）は、下の順位の表で見られます。」が出て、描かれない2本も順位の表には行がある", async () => {
  const fresh = kakuyomuRanking(FANTASY_WEEKLY, 45, localDay(0));
  const bundle = helperBundleText({ rankings: [fresh] });
  const ledger = (): Record<string, unknown> =>
    postingLedger({
      sites: [KAKUYOMU_SITE],
      profiles: [KAKUYOMU_PROFILE],
      rankings: OLD_BOARDS.map((entry, index) => helperLedgerRanking(kakuyomuRanking(entry, 20 + index, localDay(entry.offset)))),
    });
  expectBundleRoutes(bundle, ledger(), 1);
  // 描かれないのは、最後の順位がいちばん古い2本（台帳の並び＝表の上から）
  const hidden = [OLD_BOARDS[0].boardLabel, OLD_BOARDS[1].boardLabel];
  const shown = [...OLD_BOARDS.slice(2).map((entry) => entry.boardLabel), FANTASY_WEEKLY.boardLabel];

  await withVsCode(
    "ヘルパーの順位（線が多い作品）",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await keepClipboard(session, async () => {
        await clearNotifications(page);
        const since = Date.now();
        await handOverFromHelper(session, bundle);
        await waitForNotice(session, (message) => message.includes("順位 1件を取り込みました"), "「順位 1件を取り込みました」の知らせ", { since });

        const frame = await openStats(page, 1);
        await showSiteTab(frame, "kakuyomu");
        const view = await waitRankRow(frame, "kakuyomu", FANTASY_WEEKLY.boardLabel, 45, "届いた区分の45位が順位の表に出る");
        expect(view.legend, `描かれた線：${JSON.stringify(view.legend)}`).toHaveLength(6);
        expect([...view.legend].sort(), "直近に順位のある6本（届いたばかりの区分を含む）が描かれていません").toEqual([...shown].sort());
        for (const label of hidden) {
          expect(view.legend, `古い「${label}」が描かれています`).not.toContain(label);
          expect(view.rows.some((row) => row.board === label), `描かれない「${label}」が順位の表にもありません`).toBe(true);
        }
        expect(view.text).toContain(`ほかに2本の線（${hidden.join("・")}）は、下の順位の表で見られます。`);
      });
    },
    { ...LAUNCH_BASE, prepareWork: writeLedgerBeforeLaunch(ledger) }
  );
}, 240_000);
