import { describe, expect, test } from "vitest";
import {
  DEFAULT_PDF_EXPORT,
  describePdfExportPlan,
  parsePdfExportConfig,
  resolvePdfExportRequest,
} from "../../../src/core/pdfExportConfig";
import { parseWorkConfig } from "../../../src/core/workRegistry";

/**
 * ［PDF出力］の前回の設定（`config.json` の `pdfExport`）。作者の裁定 2026-10-16 夜の3：
 * 外部AIからの PDF の書き出しは、作品の前回の書き出しの設定を使う
 * （無ければ文庫サイズ・縦書き・全話）。
 */

const GRID = {
  paper: {
    kind: "grid",
    paper: "a4-landscape",
    columns: 40,
    rows: 30,
    hanging: true,
    vertical: true,
    marginMm: 10,
  },
  range: { scope: "all" },
};

describe("前回の設定を読む", () => {
  test("ふつうの紙と、選んだ話", () => {
    expect(
      parsePdfExportConfig({
        paper: { kind: "preset", preset: "a4-horizontal" },
        range: { scope: "files", files: ["本文/002_便り.txt", "本文/001_灯.txt"] },
      })
    ).toEqual({
      paper: { kind: "preset", preset: "a4-horizontal" },
      range: { scope: "files", files: ["本文/002_便り.txt", "本文/001_灯.txt"] },
    });
  });

  test("公募の納品用（字数×行数・向き・ぶら下げ・余白）", () => {
    expect(parsePdfExportConfig(GRID)).toEqual(GRID);
  });

  test("知らない紙・範囲の外の字数・選べない余白・空の選択は、欄ごと無かったことにする", () => {
    // 投げない：手で書き間違えたせいで作品が開けなくなるほうが困る（announce と同じ）
    expect(parsePdfExportConfig({ paper: { kind: "preset", preset: "b5" }, range: { scope: "all" } })).toBeUndefined();
    expect(parsePdfExportConfig({ ...GRID, paper: { ...GRID.paper, columns: 400 } })).toBeUndefined();
    expect(parsePdfExportConfig({ ...GRID, paper: { ...GRID.paper, marginMm: 3 } })).toBeUndefined();
    expect(parsePdfExportConfig({ ...GRID, range: { scope: "files", files: [] } })).toBeUndefined();
    expect(parsePdfExportConfig("文庫")).toBeUndefined();
    expect(parsePdfExportConfig(undefined)).toBeUndefined();
  });

  test("作品の設定（config.json）に載る。壊れていても作品は開ける", () => {
    const base = {
      schemaVersion: "1",
      workTitle: "灯の町",
      manuscriptDir: "本文",
      settingsDir: "設定",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(parseWorkConfig({ ...base, pdfExport: GRID }).pdfExport).toEqual(GRID);
    const broken = parseWorkConfig({ ...base, pdfExport: { paper: "文庫" } });
    expect(broken.workTitle).toBe("灯の町");
    expect("pdfExport" in broken).toBe(false);
    // 持っていない作品に欄を作らない（差分を濁らせない）
    expect("pdfExport" in parseWorkConfig(base)).toBe(false);
  });
});

describe("外部AIの依頼で使う設定を決める", () => {
  const available = ["本文/001_灯.txt", "本文/002_便り.txt", "本文/003_春.txt"];

  test("前回の記録が無ければ、文庫サイズ・縦書き・全話", () => {
    const plan = resolvePdfExportRequest(undefined, available);
    expect(plan.source).toBe("default");
    expect(plan.paper).toEqual(DEFAULT_PDF_EXPORT.paper);
    expect(plan.paper).toEqual({ kind: "preset", preset: "bunko-vertical" });
    expect(plan.files).toEqual(available);
    const lines = describePdfExportPlan(plan);
    expect(lines.paper).toContain("文庫サイズ");
    expect(lines.direction).toBe("縦書き");
    expect(lines.range).toContain("全話（3話）");
    expect(lines.source).toContain("既定");
  });

  test("前回が全話なら、いまの全話（あとから足した話も入る）", () => {
    const plan = resolvePdfExportRequest(
      { paper: { kind: "preset", preset: "a4-horizontal" }, range: { scope: "all" } },
      available
    );
    expect(plan.source).toBe("last");
    expect(plan.files).toEqual(available);
    const lines = describePdfExportPlan(plan);
    expect(lines.paper).toContain("A4");
    expect(lines.direction).toBe("横書き");
    expect(lines.source).toContain("前回");
  });

  test("前回選んだ話だけを、話の順に並べる。見つからない話は言う", () => {
    const plan = resolvePdfExportRequest(
      {
        paper: { kind: "preset", preset: "a5-vertical" },
        range: { scope: "files", files: ["本文/003_春.txt", "本文/001_灯.txt", "本文/009_消えた.txt"] },
      },
      available
    );
    expect(plan.files).toEqual(["本文/001_灯.txt", "本文/003_春.txt"]);
    expect(plan.missing).toEqual(["本文/009_消えた.txt"]);
    expect(plan.rangeFellBack).toBe(false);
    const lines = describePdfExportPlan(plan);
    expect(lines.range).toContain("前回選んだ2話");
    expect(lines.range).toContain("001_灯.txt");
    expect(lines.range).toContain("009_消えた.txt");
  });

  test("前回選んだ話が1つも無ければ全話にして、そう言う", () => {
    const plan = resolvePdfExportRequest(
      {
        paper: { kind: "preset", preset: "a5-vertical" },
        range: { scope: "files", files: ["本文/009_消えた.txt"] },
      },
      available
    );
    expect(plan.files).toEqual(available);
    expect(plan.rangeFellBack).toBe(true);
    expect(describePdfExportPlan(plan).range).toContain("全話（3話");
    expect(describePdfExportPlan(plan).range).toContain("見つからない");
  });

  test("公募の納品用は、紙と向きと字数×行数を言う", () => {
    const plan = resolvePdfExportRequest(
      GRID as Parameters<typeof resolvePdfExportRequest>[0],
      available
    );
    const lines = describePdfExportPlan(plan);
    expect(lines.paper).toContain("A4横置き");
    expect(lines.paper).toContain("40字×30行");
    expect(lines.direction).toBe("縦書き");
  });

  test("Windowsの区切りで覚えていても同じ話を指す", () => {
    const plan = resolvePdfExportRequest(
      {
        paper: { kind: "preset", preset: "a5-vertical" },
        range: { scope: "files", files: ["本文\\002_便り.txt"] },
      },
      available
    );
    expect(plan.files).toEqual(["本文/002_便り.txt"]);
  });
});
