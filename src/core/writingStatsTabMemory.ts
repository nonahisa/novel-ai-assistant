/**
 * 執筆統計で前に見ていたタブを、作品ごとに覚える（作者の判断 2026-11-01。設計書6.3.9）。
 *
 * **作品のファイルには書かない。** どのタブを見ていたかは作者の作品の記録ではなく、
 * この画面の使い勝手でしかない。`設定/` に書くとGitの同期に毎回小さな差分が乗る。
 * 拡張機能の保管庫（globalState）に置く——作品の登録簿も globalState にあるので、
 * 別のワークスペースから同じ作品を開いても同じタブで開く。
 *
 * **WebView の中の記憶（vscode.setState）には頼らない。** あれは画面1枚ぶんの
 * 記憶で、閉じると消える（0.117.0 はこちらだったので、開き直すと概要へ戻っていた）。
 *
 * VS Code API には依存しない（保管庫は形だけ受け取る。試験で作り物を渡すため）。
 */

import { POSTING_SITES, type PostingSiteId } from "../models/posting";

/** タブの鍵（画面の data-page。画面の自動テストも探すので変えない） */
export const WRITING_STATS_TABS = ["overview", "trend", "episodes", "readers"] as const;

export type WritingStatsTab = (typeof WRITING_STATS_TABS)[number];

/** 保管庫の鍵。中身は「作品ID → タブの鍵」の1つの表 */
export const WRITING_STATS_TAB_MEMORY_KEY = "novelai.writingStats.lastTab";

/** 全作品の画面を覚える鍵（作品IDと重ならない形） */
export const ALL_WORKS_TAB_KEY = "__allWorks__";

/**
 * 「読者の反応」の中のサイトのタブを覚える鍵（作者の指示 2026-11-01「サイトごとにタブを」）。
 * 中身は「作品ID → サイトの鍵」の表。外側のタブと別の表にしておく——片方の形を
 * 変えても、もう片方の記憶を巻き込んで消さないように
 */
export const READER_SITE_TAB_MEMORY_KEY = "novelai.writingStats.lastReaderSite";

function isPostingSiteId(value: unknown): value is PostingSiteId {
  return typeof value === "string" && POSTING_SITES.some((info) => info.id === value);
}

/** 保管庫の形（vscode.Memento のうち、使う所だけ） */
export interface TabMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export function isWritingStatsTab(value: unknown): value is WritingStatsTab {
  return typeof value === "string" && (WRITING_STATS_TABS as readonly string[]).includes(value);
}

/** 覚えている表。壊れていれば空として読む（使い勝手の記憶なので、止めるほどのものではない） */
function readTable(memento: TabMemento, key = WRITING_STATS_TAB_MEMORY_KEY): Record<string, unknown> {
  const raw = memento.get<unknown>(key);
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** その作品で前に見ていたタブ。覚えていなければ「概要」 */
export function rememberedWritingStatsTab(memento: TabMemento, workKey: string): WritingStatsTab {
  const value = readTable(memento)[workKey];
  return isWritingStatsTab(value) ? value : "overview";
}

/**
 * 見ているタブを覚える。**知らない鍵は覚えない**——画面から届いた値なので、
 * そのまま保管庫へ入れない。
 */
export async function rememberWritingStatsTab(
  memento: TabMemento,
  workKey: string,
  tab: unknown
): Promise<void> {
  if (!isWritingStatsTab(tab)) return;
  const table = readTable(memento);
  if (table[workKey] === tab) return;
  await memento.update(WRITING_STATS_TAB_MEMORY_KEY, { ...table, [workKey]: tab });
}

/**
 * その作品で前に見ていたサイトのタブ（読者の反応の中）。覚えていなければ null
 * ——画面がその作品の最初のサイトのタブを選ぶ（どのサイトがあるかは画面で決まる）
 */
export function rememberedReaderSiteTab(memento: TabMemento, workKey: string): PostingSiteId | null {
  const value = readTable(memento, READER_SITE_TAB_MEMORY_KEY)[workKey];
  return isPostingSiteId(value) ? value : null;
}

/** 見ているサイトのタブを覚える。知らないサイトの鍵は覚えない */
export async function rememberReaderSiteTab(
  memento: TabMemento,
  workKey: string,
  site: unknown
): Promise<void> {
  if (!isPostingSiteId(site)) return;
  const table = readTable(memento, READER_SITE_TAB_MEMORY_KEY);
  if (table[workKey] === site) return;
  await memento.update(READER_SITE_TAB_MEMORY_KEY, { ...table, [workKey]: site });
}
