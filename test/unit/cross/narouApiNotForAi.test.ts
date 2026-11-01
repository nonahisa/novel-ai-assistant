import { describe, expect, test } from "vitest";
import { buildReaderAdviceMaterials } from "../../../src/core/readerAdvice";
import { readerReactionChatBlockFromLedger } from "../../../src/core/readerAdviceChat";
import { buildPostingSiteRecords } from "../../../src/core/postingSiteRecords";
import { collectReactions } from "../../../src/core/targetSheetWritten";
import { formatReaderAdviceMaterial } from "../../../src/prompts/readerAdvice";
import {
  emptyPostingLedger,
  readerStatsForAi,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";

/**
 * **なろう小説APIから取った数は AI に渡さない**（作者がなろうの運営へ約束した使い方。
 * 作者の指示 2026-11-02）。AI へ渡す材料を作る所を通して、出どころ `narou-api` の記録が
 * 入らないことを見る：
 *
 * - 執筆統計の「AIに助言をもらう」・相談・MCP の道具（どれも `buildReaderAdviceMaterials`）
 * - 執筆統計で「AIへ渡す材料」として見せる文（送るものと同じでなければならない）
 * - 読者像の紙の「読者の反応」（作品フォルダーのファイルで、ほかの機能の材料に回りうる）
 *
 * API の数には、ほかの記録に無い目印の数（987654）を入れておき、材料の文に出ないことを見る。
 */

const readAt = "2026-11-02T03:00:00.000Z";
const MARK = 987654;

function ledger(): PostingLedger {
  const helperEpisodes: ReaderStatsRecord[] = [1, 2, 3].map((episode) => ({
    site: "narou",
    readAt: "2026-11-01T00:00:00+09:00",
    scope: "episode",
    episode,
    metrics: { pv: 300 - episode * 50 },
    source: "helper",
    updatedAt: "2026-10-01T00:00:00+09:00",
  }));
  return {
    ...emptyPostingLedger(),
    sites: [{ site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/ncode/123/" }],
    readerStats: [
      { site: "narou", readAt: "2026-11-01T00:00:00+09:00", scope: "work", metrics: { bookmarks: 12, points: 40 }, source: "helper" },
      ...helperEpisodes,
      // あとから取った API の数（日時が新しいので、除かなければ「最新」として拾われる）
      { site: "narou", readAt, scope: "work", metrics: { bookmarks: MARK, points: MARK }, source: "narou-api" },
    ],
  };
}

describe("AI へ渡す材料から、API で取った記録を除く", () => {
  test("読者の反応の助言の材料（助言のボタン・相談・MCP の道具の共通の材料）", () => {
    const materials = buildReaderAdviceMaterials(ledger(), "narou");
    expect(materials).toHaveLength(1);
    const text = materials.map((material) => formatReaderAdviceMaterial(material)).join("\n");
    expect(text).not.toContain("987,654");
    expect(text).not.toContain(String(MARK));
  });

  test("相談・MCP の道具が読む材料の文", () => {
    const block = readerReactionChatBlockFromLedger("PVとブクマの伸びを見てほしい", () => ledger());
    expect(block).toBeDefined();
    expect(block?.text).not.toContain("987,654");
    expect(block?.text).not.toContain(String(MARK));
  });

  test("執筆統計で「AIへ渡す材料」として見せる文", () => {
    const narou = buildPostingSiteRecords(ledger()).find((record) => record.site === "narou");
    expect(narou?.readerAdvice?.materialText).toBeDefined();
    expect(narou?.readerAdvice?.materialText).not.toContain("987,654");
    // 画面の表（作者が見るもの）には API の数も出る。出典も添える
    expect(narou?.readerLatest?.snapshot).toContain("987,654");
    expect(narou?.apiAttribution).toContain("なろう小説API");
  });

  test("読者像の紙の「読者の反応」", () => {
    const reactions = collectReactions(ledger());
    expect(reactions).toHaveLength(1);
    expect(reactions[0].metrics).not.toContain("987,654");
    expect(reactions[0].metrics).toContain("12");
  });

  test("除く関数は並びを保ち、API の記録だけを落とす", () => {
    const rows = ledger().readerStats;
    const kept = readerStatsForAi(rows);
    expect(kept).toHaveLength(rows.length - 1);
    expect(kept.every((row) => row.source !== "narou-api")).toBe(true);
    expect(kept).toEqual(rows.filter((row) => row.source !== "narou-api"));
  });
});
