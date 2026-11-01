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
 * **タブは1段**（作者の指示 2026-11-01「読者の反応は二段のタブとせず、『カクヨムの反応』
 * 『なろうの反応』『アルファの反応』で並べてください」）。サイトのタブも外側のタブの1つで、
 * 鍵は `site-<サイトの鍵>`。0.119.0 の「読者の反応」の中のサイトのタブ（別の表）は無くした。
 *
 * VS Code API には依存しない（保管庫は形だけ受け取る。試験で作り物を渡すため）。
 */

import { POSTING_SITES, type PostingSiteId } from "../models/posting";

/** 固定のタブの鍵（画面の data-page。画面の自動テストも探すので変えない） */
export const WRITING_STATS_TABS = ["overview", "trend", "episodes"] as const;

/** サイトのタブの鍵の頭（`site-kakuyomu` など） */
export const SITE_TAB_PREFIX = "site-";

export type WritingStatsTab = (typeof WRITING_STATS_TABS)[number] | `site-${PostingSiteId}`;

/** 保管庫の鍵。中身は「作品ID → タブの鍵」の1つの表 */
export const WRITING_STATS_TAB_MEMORY_KEY = "novelai.writingStats.lastTab";

/** 全作品の画面を覚える鍵（作品IDと重ならない形） */
export const ALL_WORKS_TAB_KEY = "__allWorks__";

/**
 * 0.119.0 で「読者の反応」の中のサイトのタブを覚えていた表（作品ID → サイトの鍵）。
 * **読むだけで、もう書かない。** 外側の表に「読者の反応」（`readers`）と覚えている作品を、
 * そのサイトのタブとして読み替えるために残す（作者の指示 2026-11-01）
 */
export const READER_SITE_TAB_MEMORY_KEY = "novelai.writingStats.lastReaderSite";

/** 0.119.0 までの「読者の反応」のタブの鍵（もう画面に無い） */
const LEGACY_READERS_TAB = "readers";

function isPostingSiteId(value: unknown): value is PostingSiteId {
  return typeof value === "string" && POSTING_SITES.some((info) => info.id === value);
}

/** サイトのタブの鍵（画面と覚える側で同じ形にするため、組み立てはここだけ） */
export function siteTabKey(site: PostingSiteId): `site-${PostingSiteId}` {
  return `site-${site}`;
}

/** 保管庫の形（vscode.Memento のうち、使う所だけ） */
export interface TabMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export function isWritingStatsTab(value: unknown): value is WritingStatsTab {
  if (typeof value !== "string") return false;
  if ((WRITING_STATS_TABS as readonly string[]).includes(value)) return true;
  return value.startsWith(SITE_TAB_PREFIX) && isPostingSiteId(value.slice(SITE_TAB_PREFIX.length));
}

/** 覚えている表。壊れていれば空として読む（使い勝手の記憶なので、止めるほどのものではない） */
function readTable(memento: TabMemento, key = WRITING_STATS_TAB_MEMORY_KEY): Record<string, unknown> {
  const raw = memento.get<unknown>(key);
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * その作品で前に見ていたタブ。覚えていなければ「概要」。
 *
 * 0.119.0 で「読者の反応」と覚えた作品は、同じ作品で覚えていたサイトのタブとして読み替える
 * （サイトを覚えていなければ概要。どのサイトかを決められない）。**読み替えは書き戻さない**
 * ——開くたびに保管庫へ書くことになる。作者がタブを押せば、新しい形で覚え直す。
 *
 * **そのサイトのタブが今の画面にあるかは、ここでは分からない**（どのサイトを配信しているかは
 * 台帳で決まる）。無いタブの鍵が届いたら、画面の側が「概要」で組む。
 */
export function rememberedWritingStatsTab(memento: TabMemento, workKey: string): WritingStatsTab {
  const value = readTable(memento)[workKey];
  if (value === LEGACY_READERS_TAB) {
    const site = readTable(memento, READER_SITE_TAB_MEMORY_KEY)[workKey];
    return isPostingSiteId(site) ? siteTabKey(site) : "overview";
  }
  return isWritingStatsTab(value) ? value : "overview";
}

/**
 * 見ているタブを覚える。**知らない鍵は覚えない**——画面から届いた値なので、
 * そのまま保管庫へ入れない（もう無い「読者の反応」も覚えない）。
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
