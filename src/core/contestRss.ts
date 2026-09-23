import { parseContestCard, type ContestListing } from "./contestListing";
import type { RssFeedResult } from "./rssFeed";

/**
 * ツクリテミライの公募一覧の RSS（設計書6.3.6.2）。
 *
 * 作者がサイトに頼んで作ってもらったフィード（2026-09-23）。**押したときだけ
 * 取りに行く**（作者の裁定）——自動では取りに行かない。
 *
 * 1件の読み取りは、ヘルパー・貼り付けと同じ `parseContestCard` を通す
 * （締切・字数の読み替えを2か所に持たない）。
 *
 * VS Code API には依存しない。
 */

/** フィードの場所。**ここ1か所だけに書く**（画面の案内・ログ・通信はこれを見る） */
export const CONTEST_RSS_URL = "https://tsukuritemirai.com/kobo/novel/feed.xml";

/** 画面に出すフィードの名前 */
export const CONTEST_RSS_LABEL = "ツクリテミライの小説の公募一覧（RSS）";

/**
 * RSS の item を公募として読む。
 *
 * - 名前は title、説明は description（「〆切 : WEB応募：2026年10月31日」のような欄を含む）
 * - リンクは link（**サイトの公募の詳しいページ**。一覧に公式のリンクは無い）
 * - 分類（category）は見出しにする
 *
 * 締切の欄の無い item は公募と読まない（`skipped` に数える）。
 */
export function contestsFromRss(feed: Extract<RssFeedResult, { ok: true }>): {
  listings: ContestListing[];
  skipped: number;
} {
  const listings: ContestListing[] = [];
  let skipped = feed.skipped;
  for (const item of feed.items) {
    const listing = parseContestCard({
      name: item.title,
      text: item.description,
      url: item.link ?? (item.guid && /^https?:\/\//u.test(item.guid) ? item.guid : null),
      section: item.categories.length > 0 ? item.categories.join("・") : null,
      source: "tsukuritemirai",
    });
    if (listing) listings.push(listing);
    else skipped++;
  }
  return { listings, skipped };
}
