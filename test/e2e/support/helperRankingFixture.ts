/**
 * ヘルパー（統合小説執筆環境ヘルパー 0.19.0）が「まとめて渡す」で VS Code へ渡すものの見本
 * （設計書6.79.7「ヘルパーからの受け口」・6.113）。**本物のヘルパー・本物のサイトは使わない。**
 *
 * ヘルパーは束（`novelai-stats-bundle`）をクリップボードへ置いてから
 * `vscode://nonahisa.novel-ai-assistant/import-reader-stats` を開く。リンクは合図だけで、
 * データはクリップボードで渡る（`core/readerStatsHelperLink.ts`）。ここでは同じ形の束を作り、
 * テスト用の VS Code の中の「Developer: Open URL」で合図を開く（`setupRequestConfirm.test.ts` と同じ道。
 * **OS には開かせない**——作者の VS Code へ届いてしまう）。
 *
 * 順位の1件の形は、ヘルパーの `content/read.js` の `readRankings` が返す形
 * （ヘルパーの `test/rankings.test.js` が固定している形。2026-11-02 の取り決め）に合わせる。
 * 区分の鍵（`board`）もヘルパーが URL から組む形（`rankings/ジャンル/期間/区分`）にする。
 *
 * 製品の型と関所（`parseReaderStatsPaste`・`rankingRecordFromHelper`）をそのまま使う——
 * 見本の形を試験の側で写すと、取り決めが変わったときに片方だけ古くなる。
 */
import type { Page } from "playwright-core";
import {
  READER_STATS_BUNDLE_KIND,
  READER_STATS_BUNDLE_VERSION,
  rankingRecordFromHelper,
  type ReaderStatsRanking,
} from "../../../src/core/readerStatsEnvelope";
import { READER_STATS_IMPORT_URI_PATH } from "../../../src/core/readerStatsHelperLink";
import { EXTENSION_URI_AUTHORITY } from "../../../src/core/setupRequest";
import { fillInput } from "./quickInput";
import type { E2ESession, LaunchOptions } from "./vscodeApp";
import { pressWorkbenchKey, quickInputWaitContext } from "./workbenchDom";

/** ヘルパーが開く取り込みの合図（パスは製品の定数から組む） */
export const READER_STATS_IMPORT_URI = `vscode://${EXTENSION_URI_AUTHORITY}${READER_STATS_IMPORT_URI_PATH}`;

/** 「Developer: Open URL」のキー（setupRequestConfirm・runRequestTypo と同じ組。製品のキーとも重ならない） */
const OPEN_URL_KEY = "ctrl+alt+shift+q";
const OPEN_URL_PRESS = "Control+Alt+Shift+KeyQ";

/**
 * ヘルパーからの取り込みを試すときの起こし方。
 *
 * - `extensions.confirmedUriHandlerExtensionIds`：VS Code 自身の「この URI を開かせますか」の問いを
 *   止める（E27 で控えた問い。setupRequestConfirm と同じ）
 * - `novelai.readerStats.importOnFocus: false`：**窓が前に出たときの「取り込みますか？」を止める。**
 *   テスト用の VS Code は起こした直後に焦点を得ることがあり、クリップボードに束を置いたあとで
 *   焦点の便が走ると、合図より先に問いが出て取り込みが重なる。作者も切れる製品の設定で、
 *   試験の口ではない。合図（URI）からの取り込みはこの設定に関わらず動く
 */
export const HELPER_LINK_LAUNCH: Required<Pick<LaunchOptions, "settings" | "keybindings">> = {
  settings: {
    "extensions.confirmedUriHandlerExtensionIds": ["nonahisa.novel-ai-assistant"],
    "novelai.readerStats.importOnFocus": false,
  },
  keybindings: [{ key: OPEN_URL_KEY, command: "workbench.action.url.openUrl" }],
};

/** 手元の今日から `offset` 日ずらした日付（YYYY-MM-DD）。製品の `todayOf`（お祝いの「今日」）と同じ組み方 */
export function localDay(offset = 0): string {
  const time = new Date();
  time.setDate(time.getDate() + offset);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

/** 束へ入れる順位の1件（ヘルパーの `readRankings` が返す形） */
export function helperRanking(input: {
  site?: "kakuyomu" | "alphapolis";
  workId: string;
  title?: string;
  board: string;
  boardLabel: string;
  span: ReaderStatsRanking["span"];
  genre?: string;
  rank: number;
  date: string;
}): ReaderStatsRanking {
  return {
    site: input.site ?? "kakuyomu",
    workId: input.workId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    board: input.board,
    boardLabel: input.boardLabel,
    span: input.span,
    ...(input.genre !== undefined ? { genre: input.genre } : {}),
    rank: input.rank,
    date: input.date,
    // 読んだ日時は、その日の日本時間の昼（日付と食い違わない時刻）
    readAt: new Date(`${input.date}T12:00:00+09:00`).toISOString(),
  };
}

/**
 * 「まとめて渡す」の束の文字列（ヘルパーの `common/stash.js` の `makeBundle` と同じ形）。
 * `items` は読者の反応の封筒（**オブジェクト**。束の中では文字列にしない）
 */
export function helperBundleText(input: { items?: readonly unknown[]; rankings?: readonly ReaderStatsRanking[] }): string {
  return JSON.stringify({
    kind: READER_STATS_BUNDLE_KIND,
    version: READER_STATS_BUNDLE_VERSION,
    handedAt: new Date().toISOString(),
    items: input.items ?? [],
    ...(input.rankings && input.rankings.length > 0 ? { rankings: input.rankings } : {}),
  });
}

/**
 * 前に取り込んであった順位として、台帳（`設定/投稿状態.json` の `rankings`）へ置く形。
 * 製品が取り込んだときに書く形そのもの（`rankingRecordFromHelper`）
 */
export function helperLedgerRanking(ranking: ReaderStatsRanking): Record<string, unknown> {
  return { ...rankingRecordFromHelper(ranking) };
}

/** 製品が読む形の投稿状態の台帳（`models/posting.ts` の PostingLedger） */
export function postingLedger(options: { sites: unknown[]; profiles: unknown[]; rankings?: unknown[] }): Record<string, unknown> {
  return {
    schemaVersion: "1",
    sites: options.sites,
    siteProfiles: options.profiles,
    posts: [],
    rankings: options.rankings ?? [],
    readerStats: [],
  };
}

/** テスト用の VS Code のクリップボード（Electron 本体の `clipboard`。**OS のクリップボードと同じもの**） */
export async function readClipboard(session: E2ESession): Promise<string> {
  return session.app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "");
}

export async function writeClipboard(session: E2ESession, text: string): Promise<void> {
  await session.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
}

/**
 * クリップボードを使う件を包む。**前の中身を控えて、終わったら戻す**
 * （OS のクリップボードは作者のものと同じ。announcementCopyButtons と同じ扱い）
 */
export async function keepClipboard<T>(session: E2ESession, body: () => Promise<T>): Promise<T> {
  const before = await readClipboard(session);
  try {
    return await body();
  } finally {
    await writeClipboard(session, before).catch(() => undefined);
  }
}

/** 束をクリップボードへ置き、ヘルパーと同じ合図を「Developer: Open URL」で開く */
export async function handOverFromHelper(session: E2ESession, bundle: string): Promise<void> {
  await writeClipboard(session, bundle);
  const placed = await readClipboard(session);
  if (placed !== bundle) {
    throw new Error(`クリップボードに束を置けませんでした（読めた字：${JSON.stringify(placed.slice(0, 120))}）`);
  }
  await openUri(session.page, READER_STATS_IMPORT_URI);
}

async function openUri(page: Page, uri: string): Promise<void> {
  await pressWorkbenchKey(page, OPEN_URL_PRESS);
  await fillInput(page, uri).catch(async (error: unknown) => {
    throw new Error(`「Open URL」の入力欄が出ません（${String(error)}）${await quickInputWaitContext(page)}`);
  });
  await page.keyboard.press("Enter");
}
