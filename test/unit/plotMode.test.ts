import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { EpisodeFile } from "../../src/models/types";
import type { Chapter } from "../../src/models/chapter";
import type { ChapterSynopsis } from "../../src/models/synopsis";
import { isBlankPlotSection, parsePlotMarkdown } from "../../src/core/plotDoc";
import { buildPlotTemplate } from "../../src/core/plotTemplate";
import {
  PLOT_MODE_AI_COMMANDS,
  appendPlotSection,
  buildPlotEpisodeRows,
  listPlotHeadings,
  synopsisHead,
  unusedPlotSections,
} from "../../src/core/plotMode";
import { allActions } from "../../src/views/actionList";

/**
 * プロットモードの画面の材料（設計書6.4.8）。
 *
 * **文書を欄に閉じ込めない**（6.4.3）ので、ここが作るのは
 * 「どこに何があるか」の目録だけである。中身は plot.md にしかない。
 */

function episode(over: Partial<EpisodeFile> & { fileName: string }): EpisodeFile {
  return {
    filePath: `C:/work/本文/${over.fileName}`,
    ext: ".txt",
    chapterStart: null,
    chapterEnd: null,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: {
      gross: 0,
      net: 0,
      lines: 0,
      paragraphs: 0,
      manuscriptLines: 0,
    },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
    ...over,
  } as EpisodeFile;
}

describe("節の目次", () => {
  test("見出しと行番号が対応する", () => {
    const text = "# 作品\n\n## ログライン\n本文。\n\n## あらすじ\n- 出来事\n";

    expect(listPlotHeadings(text)).toEqual([
      { heading: "ログライン", key: "logline", line: 3 },
      { heading: "あらすじ", key: "outline", line: 6 },
    ]);
  });

  test("作者が立てた見出しも並べる（決まった項目だけにしない）", () => {
    // 6.4.3。自由に書いた節へも飛べないと、目次として役に立たない
    const text = "# 作品\n\n## 参考にした作品\n- あの小説\n";

    expect(listPlotHeadings(text)).toEqual([
      { heading: "参考にした作品", key: null, line: 3 },
    ]);
  });

  test("節の見出し（##）だけを拾う", () => {
    // `#` は文書の題、`###` 以下は節の中の小見出し。
    // `updatePlotMarkdown` が節と見なす段だけを目次にする
    const text = "# 作品\n\n## ログライン\n### 補足\n本文。\n";

    expect(listPlotHeadings(text).map((entry) => entry.heading)).toEqual([
      "ログライン",
    ]);
  });

  test("書いてある見出しは、候補に出ない", () => {
    const text = "# 作品\n\n## ログライン\n本文。\n";
    const candidates = unusedPlotSections(text).map((def) => def.heading);

    expect(candidates).not.toContain("ログライン");
    expect(candidates).toContain("テーマ");
    // 書き出しの見出しは2つだけなので、残りはすべて候補に出る
    expect(candidates).toContain("あらすじ");
  });

  test("書き出しのままなら、候補はログラインとあらすじ以外", () => {
    const candidates = unusedPlotSections(buildPlotTemplate("作品")).map(
      (def) => def.heading
    );

    expect(candidates).not.toContain("ログライン");
    expect(candidates).not.toContain("あらすじ");
    expect(candidates).toContain("世界観");
  });
});

describe("候補を押して見出しを足す", () => {
  const before = "# 作品\n\n## ログライン\n本文。\n";

  test("末尾へ足す。既存の行は1文字も変わらない", () => {
    // 6.4.3の要。決まった順へ割り込ませると、作者の並びが崩れる
    const after = appendPlotSection(before, "worldview", {
      workTitle: "作品",
    });

    expect(after.startsWith("# 作品\n\n## ログライン\n本文。\n")).toBe(true);
    expect(after).toContain("## 世界観");
    expect(after.indexOf("## 世界観")).toBeGreaterThan(
      after.indexOf("## ログライン")
    );
  });

  test("足した節は、まだ「書かれていない」ものとして数える", () => {
    // 案内を置くだけなので、逆算（P-02）はここを空として埋められる
    const after = appendPlotSection(before, "worldview", { workTitle: "作品" });
    const parsed = parsePlotMarkdown(after);

    expect(isBlankPlotSection(parsed.sections.worldview)).toBe(true);
  });

  test("既にある見出しには触らない", () => {
    // `updatePlotMarkdown` は見出しがあれば中身を差し替える。
    // 候補として押されたものが実は在った場合、作者の文章が消える
    const after = appendPlotSection(before, "logline", { workTitle: "作品" });

    expect(after).toBe(before);
  });
});

describe("話の一覧", () => {
  const episodes = [
    episode({ fileName: "001.txt", chapterStart: 1, chapterEnd: 1 }),
    episode({
      fileName: "002_旅立ち.txt",
      chapterStart: 2,
      chapterEnd: 2,
      subtitle: "旅立ち",
      counts: {
        gross: 1200,
        net: 1100,
        lines: 40,
        paragraphs: 12,
        manuscriptLines: 60,
      },
    }),
    episode({ fileName: "プロローグ.txt", kind: "プロローグ" }),
  ];
  const chapters: Chapter[] = [
    { name: "第一章　出立", startEpisodePath: "本文/001.txt" },
  ];
  const synopses: ChapterSynopsis[] = [
    {
      chapter: 2,
      fileName: "002_旅立ち.txt",
      title: "旅立ち",
      synopsis: "少年は村を出て、街道で老人と出会い、旅の連れを得る。",
      sourceHash: "x",
    },
  ];

  const rows = buildPlotEpisodeRows({
    episodes,
    chapters,
    workFolder: "C:/work",
    synopses,
    episodePlotChapters: new Set([1]),
  });

  test("走査の順に並ぶ（並べ替えない）", () => {
    expect(rows.map((row) => row.fileName)).toEqual([
      "001.txt",
      "002_旅立ち.txt",
      "プロローグ.txt",
    ]);
  });

  test("単話プロットの有無が付く", () => {
    expect(rows[0].hasEpisodePlot).toBe(true);
    expect(rows[1].hasEpisodePlot).toBe(false);
  });

  test("話数の読めない話では、単話プロットを作れない", () => {
    // 置き場の名前（第N話.md）を作れない（設計書6.36.2と同じ扱い）
    expect(rows[2].chapter).toBeNull();
    expect(rows[2].canCreateEpisodePlot).toBe(false);
    expect(rows[0].canCreateEpisodePlot).toBe(true);
  });

  test("章名が添う。章の外の話は空", () => {
    expect(rows[0].chapterName).toBe("第一章　出立");
    expect(rows[1].chapterName).toBe("第一章　出立");
  });

  test("章立てが無ければ、章名は捏造しない", () => {
    const bare = buildPlotEpisodeRows({
      episodes,
      chapters: [],
      workFolder: "C:/work",
      synopses: [],
      episodePlotChapters: new Set(),
    });

    expect(bare.every((row) => row.chapterName === "")).toBe(true);
  });

  test("各話あらすじの冒頭が20字で添う", () => {
    expect(rows[1].synopsisHead).toBe("少年は村を出て、街道で老人と出会い、旅の…");
    expect(rows[0].synopsisHead).toBe("");
  });

  test("本文の有無と文字数が付く", () => {
    expect(rows[0].hasManuscript).toBe(false);
    expect(rows[1].hasManuscript).toBe(true);
    expect(rows[1].net).toBe(1100);
    expect(rows[1].gross).toBe(1200);
  });

  test("見出しは作品の形式に従う", () => {
    expect(rows[0].label).toBe("第1話");
    expect(rows[2].label).toBe("プロローグ");
  });
});

describe("あらすじの冒頭", () => {
  test("20字を超えたら…を添える", () => {
    expect(synopsisHead("あ".repeat(21))).toBe("あ".repeat(20) + "…");
  });

  test("20字以下はそのまま", () => {
    expect(synopsisHead("あ".repeat(20))).toBe("あ".repeat(20));
  });

  test("改行は空白に畳む（1行で見せる）", () => {
    expect(synopsisHead("一行目\n二行目")).toBe("一行目 二行目");
  });
});

describe("AIの入口は、既存の操作を呼ぶだけ", () => {
  test("並べた操作は、すべて詳細メニューに実在する", () => {
    // 写しを作らないので、改名されるとボタンが何も起こさなくなる
    const commands = allActions().map((action) => action.command);
    for (const command of PLOT_MODE_AI_COMMANDS) {
      expect(commands, command).toContain(command);
    }
  });
});

describe("書き込みの道を増やさない（設計書6.4.8）", () => {
  const source = readFileSync("src/features/plotModePanel.ts", "utf-8");

  test("パネルは atomicWriteFile を直に呼ばない", () => {
    // 既存ファイルの書き換えは、退避→新規作成をする経路だけを通る
    // （`writePlotText`）。直に呼ぶ処理を新しく作らない（CLAUDE.md 規則2）
    expect(source).not.toContain("atomicWriteFile");
  });

  test("plot.md への書き足しは updatePlotMarkdown の1本だけ", () => {
    // 組み立ては `appendPlotSection`（中で `updatePlotMarkdown` を呼ぶ）。
    // ここで別の組み立て（`buildPlotMarkdown`）を使うと、作者が立てた
    // 見出しが末尾へ寄せられる（6.4.3で捨てた作り）
    expect(source).toContain("appendPlotSection");
    expect(source).not.toContain("buildPlotMarkdown");
  });

  test("単話プロットは既存の口を呼ぶ", () => {
    expect(source).toContain("createEpisodePlot");
    expect(source).not.toContain("buildEpisodePlotTemplate");
  });
});
