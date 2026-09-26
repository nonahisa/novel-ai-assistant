import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildEpisodeCountTable } from "../../../src/core/episodeCharTable";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";
import type { EpisodeFile } from "../../../src/models/types";

/**
 * 執筆統計の「話ごとの文字数」と三つの輪（ターゲットシートの実績）も、
 * 作品一覧・下の帯と同じ数え方（純／総）に従う（作者の裁定 J1、2026-09-26）。
 *
 * ## 何が起きていたか
 *
 * `core/episodeCharTable.ts` は数え方の設定を見ておらず、純文字数で固定だった。
 * 総文字数を選んでいる作者には、作品一覧と執筆統計で同じ作品の字数が
 * 違って見えた。**1話の目標と比べる数（平均比・長短の印）も同じ数え方にする**
 * ——片方だけ変えると、表の数字と印が食い違う。
 *
 * 日次・週次の執筆量の記録は、これまでどおり純文字数で固定（`countSettings.ts`）。
 */

function episode(fileName: string, net: number, gross: number): EpisodeFile {
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
      gross,
      net,
      lines: 10,
      paragraphs: 5,
      manuscriptLines: Math.ceil(gross / 20),
    },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

// 純と総の差が話ごとに違う（空白や改行の多い話ほど総が伸びる）
const episodes = [
  episode("001.txt", 1_000, 1_200),
  episode("002.txt", 1_000, 2_600),
  episode("003.txt", 900, 1_000),
];

describe("話ごとの文字数は、数え方の設定に従う", () => {
  test("総文字数のとき、行・合計・平均・中央値・最長が総で出る", () => {
    const { rows, summary } = buildEpisodeCountTable(episodes, {
      countMode: "gross",
    });
    expect(rows.map((row) => row.chars)).toEqual([1_200, 2_600, 1_000]);
    expect(summary.countMode).toBe("gross");
    expect(summary.totalChars).toBe(4_800);
    expect(summary.averageChars).toBe(1_600);
    expect(summary.medianChars).toBe(1_200);
    // 純で比べると001と002は同じ長さ。総で比べると002が最長
    expect(summary.longest?.fileName).toBe("002.txt");
    expect(summary.shortest?.fileName).toBe("003.txt");
  });

  test("1話の目標と比べる数も、同じ数え方", () => {
    const { rows } = buildEpisodeCountTable(episodes, {
      countMode: "gross",
      perEpisodeGoal: 1_000,
    });
    // 002 は純なら目標ちょうど（1.0）、総なら 2.6 倍で「長い」
    expect(rows[1].ratio).toBeCloseTo(2.6);
    expect(rows[1].flag).toBe("long");
  });

  test("指定が無ければ純文字数（これまでどおり）", () => {
    const { rows, summary } = buildEpisodeCountTable(episodes, {
      perEpisodeGoal: 1_000,
    });
    expect(rows.map((row) => row.chars)).toEqual([1_000, 1_000, 900]);
    expect(summary.countMode).toBe("net");
    expect(summary.totalChars).toBe(2_900);
    expect(rows[1].flag).toBeNull();
  });

  test("設定を変えると、同じ作品の数字がそろって変わる", () => {
    const net = buildEpisodeCountTable(episodes, { countMode: "net" });
    const gross = buildEpisodeCountTable(episodes, { countMode: "gross" });
    expect(net.summary.totalChars).toBe(2_900);
    expect(gross.summary.totalChars).toBe(4_800);
    expect(net.rows.map((row) => row.chars)).not.toEqual(
      gross.rows.map((row) => row.chars)
    );
  });
});

describe("執筆統計の画面", () => {
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

  function render(countMode: "net" | "gross"): { cards: string; table: string } {
    const elements: Record<string, { innerHTML: string; querySelectorAll: () => [] }> = {
      "episode-cards": { innerHTML: "", querySelectorAll: () => [] },
      "episode-table": { innerHTML: "", querySelectorAll: () => [] },
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
    run(
      { getElementById: (id: string) => elements[id] },
      { episodes: buildEpisodeCountTable(episodes, { countMode }) },
      { postMessage: () => undefined }
    );
    return {
      cards: elements["episode-cards"].innerHTML,
      table: elements["episode-table"].innerHTML,
    };
  }

  test("総文字数のとき、列の見出しとカードが総で出る", () => {
    const { cards, table } = render("gross");
    expect(table).toContain(">総文字数</th>");
    expect(table).toContain(">2,600</td>");
    expect(cards).toContain("合計 4,800字");
  });

  test("純文字数のときは、これまでどおり", () => {
    const { cards, table } = render("net");
    expect(table).toContain(">純文字数</th>");
    expect(cards).toContain("合計 2,900字");
  });
});

describe("数え方を、画面の作り手まで渡している", () => {
  const read = (file: string) =>
    readFileSync(resolve(__dirname, "../../../src", file), "utf8");

  test("執筆統計と三つの輪は、設定の数え方で一覧を作る", () => {
    for (const file of [
      "features/writingStatsPanel.ts",
      "features/targetSheetWritten.ts",
    ]) {
      expect(read(file), file).toMatch(
        /buildEpisodeCountTable\([\s\S]{0,600}countMode: currentCountMode\(\)/
      );
    }
  });

  test("三つの輪の字数は、数え方に従う欄から取る", () => {
    const source = read("features/targetSheetWritten.ts");
    expect(source).toContain("summary.totalChars");
    expect(source).not.toContain("summary.totalNet");
    expect(source).not.toContain("summary.medianNet");
  });

  test("設定を変えたら、開いている執筆統計も描き直す", () => {
    const source = read("extension.ts");
    const start = source.indexOf("if (!needsRedraw(event)) return;");
    expect(start).toBeGreaterThan(0);
    expect(source.slice(start, start + 800)).toContain(
      "refreshOpenWritingStatsPanels("
    );
  });
});
