import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildReaderAdviceMaterials } from "../../../src/core/readerAdvice";
import { readerReactionChatBlockFromLedger } from "../../../src/core/readerAdviceChat";
import { buildPostingSiteRecords } from "../../../src/core/postingSiteRecords";
import { collectReactions } from "../../../src/core/targetSheetWritten";
import { formatReaderAdviceMaterial } from "../../../src/prompts/readerAdvice";
import { emptyPostingLedger, type PostingLedger } from "../../../src/models/posting";

/**
 * **ヘルパーがランキングの画面で読んだ順位は AI へ渡さない**（2026-11-02 の指示「順位は AI へ
 * 渡さない（今もその道は無いことを確かめる）」）。
 *
 * 1. AI へ渡す材料を作る所（助言・相談・MCP の道具・読者像の紙）を通して、順位の目印
 *    （ほかの記録に無い順位の数と見出し）が出ないことを見る
 * 2. 台帳の順位（`.rankings`）を読む所が、画面とお祝いと取り込みの部品だけであることを
 *    ソースを走査して見張る——AI の材料を組む所が新しく読み始めたら、ここで止まる
 */

const MARK_RANK = 4321;
const MARK_LABEL = "目印の区分ランキング";

function ledger(): PostingLedger {
  return {
    ...emptyPostingLedger(),
    sites: [{ site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/1111/episodes/new" }],
    readerStats: [
      { site: "kakuyomu", readAt: "2026-11-01T00:00:00.000Z", scope: "work", metrics: { pv: 120, bookmarks: 8 }, source: "helper" },
      { site: "kakuyomu", readAt: "2026-11-02T00:00:00.000Z", scope: "work", metrics: { pv: 180, bookmarks: 10 }, source: "helper" },
      // 材料が組める（話ごとの数がある）形にする（narouApiNotForAi.test.ts と同じ）
      ...[1, 2, 3].map((episode) => ({
        site: "kakuyomu" as const,
        readAt: "2026-11-02T00:00:00.000Z",
        scope: "episode" as const,
        episode,
        metrics: { pv: 300 - episode * 50 },
        source: "helper" as const,
        updatedAt: "2026-10-01T00:00:00+09:00",
      })),
    ],
    rankings: [
      {
        site: "kakuyomu",
        recordedAt: "2026-11-02T00:00:00+09:00",
        board: "rankings/fantasy/weekly/long",
        rank: MARK_RANK,
        source: "helper",
        boardLabel: MARK_LABEL,
        span: "weekly",
        genre: "異世界ファンタジー",
      },
    ],
  };
}

function expectNoMark(text: string | undefined): void {
  expect(text).toBeDefined();
  expect(text).not.toContain(String(MARK_RANK));
  expect(text).not.toContain("4,321");
  expect(text).not.toContain(MARK_LABEL);
}

describe("AI へ渡す材料に、ヘルパーの順位が入らない", () => {
  test("読者の反応の助言の材料（助言のボタン・相談・MCP の道具の共通の材料）", () => {
    const materials = buildReaderAdviceMaterials(ledger(), "kakuyomu");
    expect(materials.length).toBeGreaterThan(0);
    expectNoMark(materials.map((material) => formatReaderAdviceMaterial(material)).join("\n"));
  });

  test("相談・MCP の道具が読む材料の文", () => {
    expectNoMark(readerReactionChatBlockFromLedger("PVの伸びを見てほしい", () => ledger())?.text);
  });

  test("執筆統計で「AIへ渡す材料」として見せる文。画面の表とグラフには出る", () => {
    const kakuyomu = buildPostingSiteRecords(ledger()).find((record) => record.site === "kakuyomu");
    expectNoMark(kakuyomu?.readerAdvice?.materialText);
    expect(kakuyomu?.history[0]).toMatchObject({ board: MARK_LABEL, rank: MARK_RANK });
    expect(kakuyomu?.rankChart?.series[0].label).toBe(MARK_LABEL);
  });

  test("読者像の紙の「読者の反応」", () => {
    for (const reaction of collectReactions(ledger())) {
      expectNoMark(JSON.stringify(reaction));
    }
  });
});

describe("台帳の順位を読む所は、画面・お祝い・取り込みの部品だけ", () => {
  const SRC = resolve(__dirname, "../../../src");
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : name.endsWith(".ts") ? [full] : [];
    });
  }

  test("`.rankings` と順位の線を読むファイルの一覧", () => {
    const readers = walk(SRC)
      .filter((file) =>
        /\.rankings\b|rankingsForSite|latestRanking|buildRankSeries|buildRankChart/.test(
          readFileSync(file, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "")
        )
      )
      .map((file) => relative(SRC, file).replace(/\\/g, "/"))
      .sort();
    // 新しく足すなら、AI の材料へ流れないことを確かめてから、ここへ名前を足す
    expect(readers).toEqual([
      "core/postingSiteRecords.ts",
      "core/postingStore.ts",
      "core/rankCelebrations.ts",
      "core/rankSeries.ts",
      "core/readerStatsEnvelope.ts",
      "core/readerStatsHelperLink.ts",
      "features/postingKit.ts",
      "features/readerStats.ts",
      "features/readerStatsHelperLink.ts",
      "models/posting.ts",
    ]);
  });
});
