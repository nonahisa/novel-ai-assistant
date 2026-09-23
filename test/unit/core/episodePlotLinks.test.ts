import { describe, expect, test } from "vitest";
import {
  buildEpisodePlotTemplate,
  episodePlotTitleFromText,
  renumberEpisodePlotHeading,
} from "../../../src/core/resumeSheet";
import { parseEpisodePlot } from "../../../src/core/episodePlotDoc";
import { narrativePersonText } from "../../../src/core/plotDoc";
import {
  buildPlotEpisodeRows,
  EPISODE_PLOT_GOAL_HEAD_LENGTH,
  episodePlotGoalHead,
} from "../../../src/core/plotMode";
import type { EpisodeFile } from "../../../src/models/types";

/**
 * プロットモードと単話プロットをつなぐ細部（設計書6.4.8・6.36。
 * 作者の依頼、2026-09-23「プロットモードと単話プロットをうまくつないでくださいね」）。
 */

describe("B：人称を視点の手がかりに", () => {
  const plot = [
    "# 作品",
    "",
    "## 人称",
    "<!-- 一人称 / 三人称一元 / 三人称多元 -->",
    "三人称一元（主人公の悠）",
    "",
    "## あらすじ",
    "- ",
  ].join("\n");

  test("plot.md の人称に作者が書いた文を読む（案内は落とす）", () => {
    expect(narrativePersonText(plot)).toBe("三人称一元（主人公の悠）");
  });

  test("書かれていなければ空", () => {
    expect(narrativePersonText("## 人称\n<!-- 一人称 / 三人称一元 / 三人称多元 -->\n")).toBe("");
    expect(narrativePersonText("")).toBe("");
  });

  test("複数行は1行に畳む（括弧書きの行が割れないように）", () => {
    expect(narrativePersonText("## 人称\n- 一人称\n- 章によって交代\n")).toBe("一人称／章によって交代");
  });

  test("雛形の視点の問いかけの下に、括弧書きで添える", () => {
    const text = buildEpisodePlotTemplate(3, "", "三人称一元（主人公の悠）");
    const lines = text.split("\n");
    const at = lines.indexOf("## 視点");
    expect(lines[at + 2]).toBe("（作品の人称：三人称一元（主人公の悠））");
  });

  test("添えた行は空として読む（AIへ問いかけを渡さない）", () => {
    const doc = parseEpisodePlot(buildEpisodePlotTemplate(3, "", "一人称"));
    expect(doc.viewpoint).toBe("");
    expect(doc.blanks).toContain("視点");
  });

  test("人称が空なら、いまの雛形のまま", () => {
    expect(buildEpisodePlotTemplate(3, "題", "")).toBe(buildEpisodePlotTemplate(3, "題"));
  });
});

describe("D：見出しの話数を付け替える", () => {
  test("題のある見出し。題は保つ", () => {
    const before = buildEpisodePlotTemplate(5, "嵐の夜");
    const after = renumberEpisodePlotHeading(before, 4);
    expect(after.split("\n")[0]).toBe("# 第4話「嵐の夜」の単話プロット");
    expect(episodePlotTitleFromText(after)).toBe("嵐の夜");
    // 見出しのほかは1文字も変えない
    expect(after.split("\n").slice(1)).toEqual(before.split("\n").slice(1));
  });

  test("題の無い見出し", () => {
    expect(renumberEpisodePlotHeading("# 第5話の単話プロット\n本文", 6)).toBe(
      "# 第6話の単話プロット\n本文"
    );
  });

  test("作者が見出しを書き換えていたら触らない", () => {
    const text = "# 嵐の夜のメモ\n- 展開";
    expect(renumberEpisodePlotHeading(text, 4)).toBe(text);
  });

  test("先頭のBOMと改行コードを保つ", () => {
    const text = "﻿# 第5話の単話プロット\r\n本文\r\n";
    expect(renumberEpisodePlotHeading(text, 2)).toBe("﻿# 第2話の単話プロット\r\n本文\r\n");
  });
});

describe("A：一覧に目標を1行", () => {
  test("目標を1行に畳む", () => {
    const text = [
      "# 第3話の単話プロット",
      "## この話の目標",
      "悠が師匠の嘘に気づく。",
      "読者に疑いを渡す。",
    ].join("\n");
    expect(episodePlotGoalHead(text)).toBe("悠が師匠の嘘に気づく。 読者に疑いを渡す。");
  });

  test("長ければ省略記号で切る", () => {
    const long = "あ".repeat(EPISODE_PLOT_GOAL_HEAD_LENGTH + 5);
    const head = episodePlotGoalHead(`## この話の目標\n${long}`);
    expect(head).toBe(`${"あ".repeat(EPISODE_PLOT_GOAL_HEAD_LENGTH)}…`);
  });

  test("問いかけのまま・空なら出さない", () => {
    expect(episodePlotGoalHead(buildEpisodePlotTemplate(3))).toBe("");
  });

  test("行に目標と伏線の数が入る（書いた話と予定の話の両方）", () => {
    const episode = {
      filePath: "/w/本文/001.txt",
      fileName: "001.txt",
      chapterStart: 1,
      chapterEnd: null,
      counts: { gross: 10, net: 10, lines: 1, paragraphs: 1, manuscriptLines: 1 },
      hasConflictMarkers: false,
    } as unknown as EpisodeFile;
    const rows = buildPlotEpisodeRows({
      episodes: [episode],
      chapters: [],
      workFolder: "/w",
      synopses: [],
      episodePlotChapters: new Set([1, 2]),
      plannedEpisodes: [{ chapter: 2, title: "", filePath: "/w/設定/episode-plots/第2話.md", goal: "予定の目標" }],
      episodePlotGoals: new Map([[1, "書いた話の目標"]]),
      foreshadowCounts: new Map([[1, { planted: 2, resolved: 0, planned: 0 }]]),
    });
    expect(rows[0].goalHead).toBe("書いた話の目標");
    expect(rows[0].foreshadowCounts).toEqual({ planted: 2, resolved: 0, planned: 0 });
    expect(rows[1].planned).toBe(true);
    expect(rows[1].goalHead).toBe("予定の目標");
    expect(rows[1].foreshadowCounts).toEqual({ planted: 0, resolved: 0, planned: 0 });
  });
});
