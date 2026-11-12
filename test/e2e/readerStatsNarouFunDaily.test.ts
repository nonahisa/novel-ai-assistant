/**
 * ヘルパー（統合小説執筆環境ヘルパー）が、なろうファンDB（Narou.fun）の作品ページから読んだ「日ごとの表」を
 * 「まとめて渡す」で渡したとき、VS Code の側で起きること（画面の自動テスト、設計書6.79.7・6.3.9・6.113。
 * ヘルパーの実機確認リスト「Narou.fun の日ごとの表を…」「記録の日時が…」の、受け手の側）。
 *
 * 見張ること：
 * 1. 束（リニューアル後のヘルパーの実物の形。`unit/support/helperSamples.ts`）を取り込みの合図で受けると、
 *    「読者の反応を取り込みました：「…」1画面」が出て、`設定/投稿状態.json` の `readerStats` に作品全体の
 *    1行と日ごと27行が入る（減った3日は負の数）。記録の日時は「データ取得」の日の 0:00（日本時間）
 * 2. 執筆統計の「なろうの反応」に「日ごとのブックマークの増減（作品全体）」が出て、**減った日の棒は
 *    0の線より下へ伸び、赤（`.bar.negative` の塗り）**、増えた日は0の線より上で赤でない。0の線の位置と
 *    棒の位置・塗りの色を、描かれた SVG から読む（画面の組み立てだけの確認は単体テスト
 *    `unit/features/helperHandoverNarouFun.test.ts`）。写真を残す（下）
 * 3. 履歴の表の日時が「データ取得」の日（手元の時計での 0:00）で、メモが「…データ取得の日」。
 *    同じ束をもう一度渡すと「すでに取り込んだ数と同じでした」で、台帳の行は増えない
 *
 * **写真**：増減のグラフと執筆統計の面の写真を、環境変数 `NOVELAI_E2E_PHOTOS`（無ければ一時フォルダーの
 * `novelai-e2e-photos`）へ残す。作者は写真で「減った日が赤で0の線より下か」の見た目を答えるだけにする。
 *
 * **作者の目に残すもの**：赤の見分けやすさ・暗いテーマでの見え方（ここは色が赤であることだけを機械で見る）。
 * **本物のサイト・本物のヘルパーは使わない。AI は呼ばない。**
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { parseReaderStatsPaste } from "../../src/core/readerStatsEnvelope";
import { routeReaderStatsBundleItem } from "../../src/core/readerStatsHelperLink";
import { parsePostingLedger, type PostingLedger } from "../../src/models/posting";
import {
  helperBundle,
  narouFunHelperEnvelope,
  NAROU_FUN_BOOKMARK_DELTAS,
  NAROU_FUN_FETCHED_AT,
  NAROU_FUN_NCODE,
} from "../unit/support/helperSamples";
import { readJsonWhenPresent } from "./support/fileSettle";
import { HELPER_LINK_LAUNCH, handOverFromHelper, keepClipboard, postingLedger } from "./support/helperRankingFixture";
import { describeNotices, recordedNotices, waitForNotice } from "./support/noticeRecord";
import { statsFrame } from "./support/statsFixture";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = { name: "001_はじまり.txt", text: "一行目の文。\n" };

const NAROU_SITE = { site: "narou", newEpisodeUrl: `https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/${NAROU_FUN_NCODE}/` };
const NAROU_PROFILE = { site: "narou", workId: NAROU_FUN_NCODE };

/** 製品が出どころをメモに残す文（`readerStatsRecordsFromEnvelope`。「データ取得」の日の言い方） */
const NOTE = "Narou.funから読み取り（日時はNarou.funのデータ取得の日）";

const OPEN_STATS_KEY = { key: "ctrl+alt+shift+u", command: "novelai.showWritingStats" };
const OPEN_STATS_PRESS = "Control+Alt+Shift+KeyU";
const LAUNCH = {
  settings: HELPER_LINK_LAUNCH.settings,
  keybindings: [...HELPER_LINK_LAUNCH.keybindings, OPEN_STATS_KEY],
};

const PHOTO_DIR = process.env.NOVELAI_E2E_PHOTOS || path.join(tmpdir(), "novelai-e2e-photos");

function ledgerBody(): Record<string, unknown> {
  return postingLedger({ sites: [NAROU_SITE], profiles: [NAROU_PROFILE] });
}

function prepareLedger(): LaunchOptions["prepareWork"] {
  return async ({ workFolder }) => {
    await mkdir(path.join(workFolder, "設定"), { recursive: true });
    await writeFile(path.join(workFolder, "設定", "投稿状態.json"), JSON.stringify(ledgerBody(), null, 2), "utf8");
  };
}

async function readLedger(session: E2ESession): Promise<PostingLedger> {
  return readJsonWhenPresent<PostingLedger>(path.join(session.workFolder, "設定", "投稿状態.json"));
}

/** 見本の束が製品の関所を通り、作品に決まる形かを、VS Code を起こす前に確かめる（走った機械で原因が文で分かるように） */
function expectBundleRoutes(bundle: string): void {
  const parsed = parseReaderStatsPaste(bundle);
  expect(parsed.ok && parsed.kind === "bundle", `見本の束が読めません：${JSON.stringify(parsed)}`).toBe(true);
  if (!parsed.ok || parsed.kind !== "bundle") return;
  expect(parsed.bundle.items).toHaveLength(1);
  const item = parsed.bundle.items[0].result;
  expect(item.ok, `見本の画面が読めません：${JSON.stringify(item)}`).toBe(true);
  if (!item.ok) return;
  expect(routeReaderStatsBundleItem(item.envelope, [{ id: "見本", ledger: parsePostingLedger(ledgerBody()) }])).toEqual({
    kind: "work",
    id: "見本",
  });
}

async function openStats(page: Page): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_STATS_PRESS);
  let frame: Frame | undefined;
  await waitUntil(async () => (frame = await statsFrame(page)) !== undefined, "執筆統計の画面が開く", 30_000);
  const found = frame as Frame;
  await waitUntil(async () => (await found.locator(".tab[data-site]").count()) === 1, "サイトのタブが1つ（なろう）出る", 20_000);
  return found;
}

/** 描かれた増減の棒グラフ1つ（画面の中の座標。SVG の要素の矩形） */
interface DrawnChange {
  title: string;
  axis: { top: number; bottom: number } | null;
  bars: Array<{ negative: boolean; top: number; bottom: number; fill: string; label: string }>;
  hint: boolean;
}

/** 「日ごとのブックマークの増減」の棒グラフを読む（写真を撮れるよう、箱に印を付ける） */
async function readBookmarkChange(frame: Frame): Promise<DrawnChange | null> {
  return frame.evaluate(() => {
    const page = document.querySelector("#page-site-narou");
    const sub = Array.from(page?.querySelectorAll(".site-sub") ?? []).find((node) =>
      (node.textContent ?? "").includes("日ごとのブックマークの増減")
    );
    if (!sub) return null;
    let next = sub.nextElementSibling;
    while (next && !next.classList.contains("chart-wrap") && !next.classList.contains("site-sub")) next = next.nextElementSibling;
    if (!next || !next.classList.contains("chart-wrap")) return null;
    next.setAttribute("data-e2e-photo", "bookmark-change");
    const axis = next.querySelector("line.axis");
    const axisRect = axis ? axis.getBoundingClientRect() : null;
    return {
      title: (sub.textContent ?? "").trim(),
      axis: axisRect ? { top: axisRect.top, bottom: axisRect.bottom } : null,
      bars: Array.from(next.querySelectorAll("rect.bar")).map((bar) => {
        const rect = bar.getBoundingClientRect();
        return {
          negative: bar.classList.contains("negative"),
          top: rect.top,
          bottom: rect.bottom,
          fill: getComputedStyle(bar).fill,
          label: bar.querySelector("title")?.textContent ?? "",
        };
      }),
      hint: (page?.textContent ?? "").includes("0の線より下"),
    };
  });
}

/** `rgb(241, 76, 76)` を [r, g, b] に */
function rgbOf(fill: string): [number, number, number] | null {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(fill);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** 赤が優勢か（VS Code の `charts.red`。テーマで色合いは変わるので、赤の成分が他より十分大きいことだけ見る） */
function isRed(fill: string): boolean {
  const rgb = rgbOf(fill);
  return rgb !== null && rgb[0] >= 150 && rgb[0] > rgb[1] + 50 && rgb[0] > rgb[2] + 50;
}

/** 手元の時計での「2026/10/31 00:00」（画面の `formatWhen` と同じ組み立て） */
function localWhen(iso: string): string {
  const when = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${when.getFullYear()}/${pad(when.getMonth() + 1)}/${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

test("ヘルパーが渡したNarou.funの日ごとの表を取り込むと、台帳にデータ取得の日の 0:00 の記録が入り、執筆統計の増減のグラフで減った日が赤で0の線より下に出て、同じ束をもう一度渡しても行は増えない", async () => {
  const bundle = helperBundle([narouFunHelperEnvelope()], { ownedVia: "approved" });
  expectBundleRoutes(bundle);

  await withVsCode(
    "Narou.funの日ごとの表の取り込み",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await keepClipboard(session, async () => {
        await clearNotifications(page);

        // ── 渡す：知らせ ──
        const since = Date.now();
        await handOverFromHelper(session, bundle);
        const notice = await waitForNotice(
          session,
          (message) => message.includes("読者の反応を取り込みました"),
          "「読者の反応を取り込みました」の知らせ",
          { since }
        );
        expect(notice).toContain(`「${E2E_WORK_TITLE}」1画面`);

        // ── ファイル：作品全体の1行と日ごと27行・記録の日時・メモ ──
        let saved: PostingLedger | undefined;
        await waitUntil(
          async () => ((saved = await readLedger(session)).readerStats ?? []).length === 1 + NAROU_FUN_BOOKMARK_DELTAS.length,
          `台帳に ${1 + NAROU_FUN_BOOKMARK_DELTAS.length} 行（作品全体1＋日ごと${NAROU_FUN_BOOKMARK_DELTAS.length}）が入る`,
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（台帳の行：${saved?.readerStats?.length}／${await describeNotices(session, since - 1_000)}）`);
        });
        const rows = (saved as PostingLedger).readerStats;
        expect(rows.every((row) => row.site === "narou" && row.source === "helper" && row.note === NOTE)).toBe(true);
        // 記録の日時は、押した時刻でなく「データ取得 2026/10/31」の 0:00（日本時間）
        expect(rows.every((row) => Date.parse(row.readAt) === Date.parse(NAROU_FUN_FETCHED_AT))).toBe(true);
        expect(Date.parse(NAROU_FUN_FETCHED_AT)).toBe(Date.parse("2026-10-31T00:00:00+09:00"));
        const negatives = rows
          .filter((row) => row.period === "day" && (row.metrics.bookmarks ?? 0) < 0)
          .map((row) => [row.periodKey, row.metrics.bookmarks]);
        expect(negatives).toEqual([
          ["2026-10-12", -2],
          ["2026-10-19", -1],
          ["2026-10-28", -1],
        ]);

        // ── 画面：なろうの反応のタブの増減のグラフ ──
        const frame = await openStats(page);
        await frame.locator(`.tab[data-page="site-narou"]`).click();
        await waitUntil(
          async () => frame.evaluate(() => document.querySelector("#page-site-narou.active") !== null),
          "「なろうの反応」のタブが前に出る",
          10_000
        );
        let chart: DrawnChange | null = null;
        await waitUntil(async () => (chart = await readBookmarkChange(frame)) !== null, "「日ごとのブックマークの増減」のグラフが出る", 20_000).catch(
          async (error: unknown) => {
            const subs = await frame.evaluate(() =>
              Array.from(document.querySelectorAll("#page-site-narou .site-sub")).map((node) => (node.textContent ?? "").trim())
            );
            throw new Error(`${String(error)}（見出し：${JSON.stringify(subs)}）`);
          }
        );
        const drawn = chart as unknown as DrawnChange;
        expect(drawn.title).toBe("日ごとのブックマークの増減（作品全体）");
        expect(drawn.bars).toHaveLength(NAROU_FUN_BOOKMARK_DELTAS.length);
        expect(drawn.axis, "0の線がありません").not.toBeNull();
        const axisY = (drawn.axis as { top: number; bottom: number }).top;

        const negativeBars = drawn.bars.filter((bar) => bar.negative);
        // 減った3日（−2・−1・−1）だけが negative で、棒の吹き出しに −2・−1・−1 が入っている
        expect(negativeBars.map((bar) => bar.label.replace(/^\S+\s+/, ""))).toEqual([
          expect.stringContaining("−2"),
          expect.stringContaining("−1"),
          expect.stringContaining("−1"),
        ]);
        for (const bar of negativeBars) {
          // 0の線より下（上端が0の線の位置か、それより下）に伸び、赤で塗られる
          expect(bar.top, `減った日の棒が0の線より下にありません：${JSON.stringify({ axisY, bar })}`).toBeGreaterThanOrEqual(axisY - 1);
          expect(bar.bottom).toBeGreaterThan(bar.top);
          expect(isRed(bar.fill), `減った日の棒が赤ではありません（塗り：${bar.fill}）`).toBe(true);
        }
        for (const bar of drawn.bars.filter((candidate) => !candidate.negative && candidate.bottom - candidate.top > 0.5)) {
          // 増えた日は0の線より上へ伸び、赤で塗られない
          expect(bar.bottom, `増えた日の棒が0の線より上にありません：${JSON.stringify({ axisY, bar })}`).toBeLessThanOrEqual(axisY + 1);
          expect(isRed(bar.fill), `増えた日の棒が赤です（塗り：${bar.fill}）`).toBe(false);
        }
        // 減った日があるときだけ出る読み方の添え書き
        expect(drawn.hint, "「0の線より下」の添え書きがありません").toBe(true);

        // ── 履歴の表：日時はデータ取得の日（0:00）、メモは「データ取得の日」 ──
        const history = await frame.evaluate(() => {
          const page = document.querySelector("#page-site-narou");
          return Array.from(page?.querySelectorAll("table") ?? [])
            .map((table) => ({
              head: Array.from(table.querySelectorAll("thead th")).map((th) => (th.textContent ?? "").trim()),
              rows: Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
                Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())
              ),
            }))
            .filter((table) => table.head[0] === "日時" && table.head.includes("メモ"));
        });
        expect(history.length, `履歴の表（日時・メモの列があるもの）がありません：${JSON.stringify(history)}`).toBeGreaterThan(0);
        const memoColumn = history[0].head.indexOf("メモ");
        expect(history[0].rows.length).toBe(1);
        expect(history[0].rows[0][0]).toBe(localWhen(NAROU_FUN_FETCHED_AT));
        expect(history[0].rows[0][memoColumn]).toBe(NOTE);
        expect(JSON.stringify(history)).not.toContain("最終取得日時");

        // ── 写真：増減のグラフと、執筆統計の面 ──
        await mkdir(PHOTO_DIR, { recursive: true });
        const chartBox = frame.locator('[data-e2e-photo="bookmark-change"]');
        await chartBox.scrollIntoViewIfNeeded();
        await chartBox.screenshot({ path: path.join(PHOTO_DIR, "narou-fun-日ごとのブックマークの増減.png") });
        await page.screenshot({ path: path.join(PHOTO_DIR, "narou-fun-執筆統計のなろうの反応.png") });

        // ── 同じ束をもう一度：取り込んだものと同じ。行は増えない ──
        await clearNotifications(page);
        const againSince = Date.now();
        await handOverFromHelper(session, bundle);
        const again = await waitForNotice(
          session,
          (message) => message.includes("すでに取り込んだ数と同じでした"),
          "同じ束で「すでに取り込んだ数と同じでした」の知らせ",
          { since: againSince }
        );
        expect(again).toContain("記録は変えていません");
        await holdsFor(
          async () => ((await readLedger(session)).readerStats ?? []).length === 1 + NAROU_FUN_BOOKMARK_DELTAS.length,
          "同じ束では台帳の行が増えない",
          3_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（台帳の行：${(await readLedger(session)).readerStats?.length}／知らせ：${JSON.stringify((await recordedNotices(session)).slice(-3).map((entry) => entry.message.slice(0, 80)))}）`);
        });
      });
    },
    { ...LAUNCH, prepareWork: prepareLedger() }
  );
}, 240_000);
