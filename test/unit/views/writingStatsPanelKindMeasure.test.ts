import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";
import { buildEpisodeCountTable } from "../../../src/core/episodeCharTable";
import type { EpisodeFile } from "../../../src/models/types";
import type { WorkKindKey } from "../../../src/core/workKind";

/**
 * 執筆量パネルの**種類の目安**（設計書6.109.7）。
 *
 * 話ごとの一覧に「目安」の列と、合計のカードを足す。**小説では列もカードも
 * 足さない**（これまでと同じ見え方）。WebView のスクリプトは文字列として
 * 埋め込まれているので、関数を切り出して偽の document で動かす
 * （writingStatsPanelBars.test.ts と同じ手）。
 */

const html = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

function functionSource(name: string): string {
  const start = script.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`関数 ${name} が見つかりません`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end + 3);
}

function episode(fileName: string, net: number): EpisodeFile {
  return {
    filePath: `C:/work/本文/${fileName}`,
    fileName,
    ext: ".txt",
    chapterStart: 1,
    chapterEnd: 1,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: {
      gross: net,
      net,
      lines: 10,
      paragraphs: 5,
      manuscriptLines: Math.ceil(net / 20),
    },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

/** 話ごとの一覧のページを描き、カードと表の HTML を返す */
function renderEpisodesFor(kind: WorkKindKey | undefined): {
  cards: string;
  table: string;
} {
  const elements: Record<string, { innerHTML: string; querySelectorAll: () => [] }> = {
    "episode-cards": { innerHTML: "", querySelectorAll: () => [] },
    "episode-table": { innerHTML: "", querySelectorAll: () => [] },
  };
  const fakeDocument = { getElementById: (id: string) => elements[id] };
  const state = {
    episodes: buildEpisodeCountTable(
      [episode("001.txt", 1_000), episode("002.txt", 600)],
      { kind }
    ),
  };
  const run = new Function(
    "document",
    "state",
    "vscode",
    [
      functionSource("escapeHtml"),
      functionSource("formatCount"),
      functionSource("meterSvg"),
      functionSource("card"),
      functionSource("renderEpisodes"),
      "renderEpisodes();",
    ].join("\n")
  );
  run(fakeDocument, state, { postMessage: () => undefined });
  return {
    cards: elements["episode-cards"].innerHTML,
    table: elements["episode-table"].innerHTML,
  };
}

describe("話ごとの一覧に、種類の目安を出す", () => {
  test("エッセイは「目安」の列と合計のカードが出る", () => {
    const { cards, table } = renderEpisodesFor("essay");
    expect(table).toContain(">目安</th>");
    expect(table).toContain("読了 約2分");
    expect(cards).toContain("種類の目安");
    expect(cards).toContain("読了 約4分");
  });

  test("小説では列もカードも足さない（これまでどおり）", () => {
    const { cards, table } = renderEpisodesFor("novel");
    expect(table).not.toContain("目安");
    expect(cards).not.toContain("種類の目安");
  });

  /**
   * ノートPCの実機確認（2026-09-25）：「目安」の列が狭く、「読了 約12分」が
   * 1字ずつ縦に折れて読めなかった。表は幅いっぱい（width:100%）で、題の列に
   * 幅を取られると、短い列ほど折り返される。
   */
  test("「目安」の列は折り返さない（見出しも中身も）", () => {
    const { table } = renderEpisodesFor("essay");
    expect(table).toContain('<th class="num measure">目安</th>');
    expect(table).toMatch(/<td class="num measure">読了 約2分<\/td>/);
    // 折り返さない指定そのもの（class だけ付けて規則が無ければ効かない）
    expect(html).toMatch(/\.measure\s*\{[^}]*white-space:\s*nowrap/);
  });

  test("概要の「作品の総量」にも、目安の短い形を添える", () => {
    expect(script).toContain("state.totals.measure ? ' / ' + state.totals.measure : ''");
  });
});
