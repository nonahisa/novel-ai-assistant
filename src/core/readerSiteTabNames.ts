/**
 * 執筆統計のサイトのタブの名前（作者の指示 2026-11-01「読者の反応は二段のタブとせず、
 * 『カクヨムの反応』『なろうの反応』『アルファの反応』で並べてください」。設計書6.3.9）。
 *
 * タブの名前は、投稿サイトの一覧（`POSTING_SITES`）の呼び名を**作者が呼びやすい短い形**に
 * したもの＋「の反応」。正式な名前（「小説家になろう」「アルファポリス」）のままでは、
 * タブが7つ並ぶと狭い幅で折り返しが増える。
 *
 * 知らせの文（「執筆統計の『カクヨムの反応』で履歴を見られます」）も同じ名前で言う——
 * 画面のタブの字面と違う名前で案内すると、作者がタブを探せない。
 *
 * VS Code API には依存しない（知らせを組む core からも呼ぶ）。
 */

import type { PostingSiteId } from "../models/posting";

/**
 * 短い呼び名。**サイトを足したら、ここにも足す**（`Record` なので、足し忘れは型検査が止める）
 */
const SHORT_NAMES: Record<PostingSiteId, string> = {
  kakuyomu: "カクヨム",
  alphapolis: "アルファ",
  narou: "なろう",
  // note は名前がもともと短いので、そのまま
  note: "note",
};

/** サイトのタブの名前（「カクヨムの反応」など） */
export function readerSiteTabLabel(site: PostingSiteId): string {
  return `${SHORT_NAMES[site]}の反応`;
}

/**
 * サイトが1つに決まらない知らせで、行き先を言う言い方。
 * 例を1つ添えて、どのタブのことかを分かるようにする
 */
export const READER_SITE_TABS_HINT = "執筆統計のサイトごとのタブ（「カクヨムの反応」など）";
