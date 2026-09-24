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

  /**
   * ブラウザ版の実機確認（2026-09-25）：「目安」を直したあとも、「原稿用紙」の
   * 「約15枚」が「約15／枚」と2行に折れ、「話」の「第10話」も折れた。理由は
   * 「目安」と同じで、題の列に幅を取られた短い列が折り返される。
   * **題の列だけは折れてよい**（長い題があるので、そこで幅を吸収する）。
   */
  describe("題の列のほかは折り返さない（話・純文字数・原稿用紙・目安・平均比）", () => {
    /** 見出しの行と、最初の話の行の、列ごとの開きタグ */
    function columns(table: string): { head: string[]; row: string[] } {
      const head = table.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "";
      const row = table.match(/<tr class="clickable"[^>]*>([\s\S]*?)<\/tr>/)?.[1] ?? "";
      return {
        head: head.match(/<th[^>]*>/g) ?? [],
        row: row.match(/<td[^>]*>/g) ?? [],
      };
    }

    for (const kind of ["essay", "novel"] as const) {
      test(`${kind === "essay" ? "目安の列があるとき" : "目安の列が無いとき（小説）"}`, () => {
        const { head, row } = columns(renderEpisodesFor(kind).table);
        const names = kind === "essay"
          ? ["話", "タイトル", "純文字数", "原稿用紙", "目安", "平均比", "長さ"]
          : ["話", "タイトル", "純文字数", "原稿用紙", "平均比", "長さ"];
        expect(head).toHaveLength(names.length);
        expect(row).toHaveLength(names.length);
        names.forEach((name, index) => {
          // 題の列は折れてよい。長さの列は棒なので、字の折り返しは関係ない
          const shouldKeep = name !== "タイトル" && name !== "長さ";
          const pattern = /class="[^"]*\b(nowrap|measure)\b/;
          expect(pattern.test(head[index]), `見出し「${name}」: ${head[index]}`).toBe(shouldKeep);
          expect(pattern.test(row[index]), `中身「${name}」: ${row[index]}`).toBe(shouldKeep);
        });
      });
    }

    test("折り返さない指定そのものがある（class だけ付けて規則が無ければ効かない）", () => {
      expect(html).toMatch(/\.nowrap\s*\{[^}]*white-space:\s*nowrap/);
    });

    /**
     * 折れなくした分、狭い画面では表の幅が画面を超えうる。そのときは表の
     * 入れ物だけを横に送れるようにする（画面全体を横にずらさない）。
     */
    /**
     * 420px の画面で試したところ、折らない列に幅を取られた題の列が1字幅まで
     * 細り、題が1字ずつ縦に並んだ（1行が700px を超えた）。題は折れてよいが、
     * 最低の幅は持たせる。
     */
    test("題の列は細りすぎない（最低の幅を持つ）", () => {
      const { head, row } = columns(renderEpisodesFor("essay").table);
      expect(head[1]).toContain("episode-title");
      expect(row[1]).toContain("episode-title");
      expect(html).toMatch(/\.episode-title\s*\{[^}]*min-width:/);
      // 題の列は折れてよいまま
      expect(html).not.toMatch(/\.episode-title\s*\{[^}]*white-space:\s*nowrap/);
    });

    test("話ごとの表の入れ物は、はみ出したら横に送れる", () => {
      const holder = html.match(/<div id="episode-table"[^>]*>/)?.[0] ?? "";
      const classes = holder.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
      expect(classes.length, holder).toBeGreaterThan(0);
      const scrolls = classes.some((name) =>
        new RegExp(`\\.${name}\\s*\\{[^}]*overflow-x:\\s*auto`).test(html)
      );
      expect(scrolls, holder).toBe(true);
    });
  });

  test("概要の「作品の総量」にも、目安の短い形を添える", () => {
    expect(script).toContain("state.totals.measure ? ' / ' + state.totals.measure : ''");
  });
});
