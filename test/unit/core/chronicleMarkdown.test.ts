import { describe, expect, it } from "vitest";
import {
  buildEmptyChronicleGuide,
  chronicleToMarkdown,
} from "../../src/core/chronicleMarkdown";
import type {
  ChronicleRow,
  ChronicleSection,
} from "../../src/core/chronicle";

/**
 * 年表のMarkdown書き出し（設計書6.39.4）。
 *
 * 画面は絞り込みで見せ方を変えるが、書き出しは**そのとき見えている形**を
 * 残すためのものである。段と時期の見出しが出ること、表の列が揃うことだけを
 * 確かめる。
 */

function row(patch: Partial<ChronicleRow> = {}): ChronicleRow {
  return {
    filePath: "C:/works/w1/本文/第01話.txt",
    fileName: "第01話.txt",
    workPath: "本文/第01話.txt",
    chapter: 1,
    chapterEnd: 1,
    chapterLabel: "第1話",
    title: null,
    chars: 100,
    synopsis: null,
    appeared: [],
    events: [],
    timepoint: null,
    line: null,
    ...patch,
  };
}

function section(
  label: string,
  rows: ChronicleRow[],
  kind: ChronicleSection["kind"] = "canonical"
): ChronicleSection {
  return { label, line: null, kind, rows };
}

describe("年表のMarkdown", () => {
  it("何も無ければ、次に何をすればよいかを書く", () => {
    // 黙って空の表を出すと、壊れているのか未記入なのか見分けられない
    const markdown = chronicleToMarkdown([]);

    expect(markdown).toBe(buildEmptyChronicleGuide());
    expect(markdown).toContain("並べる話がありません");
  });

  it("段の見出しが、渡した順に並ぶ", () => {
    const markdown = chronicleToMarkdown([
      section("本編", [row()]),
      section("IF・もし文佳が生きていたら", [row({ chapter: 4 })], "alternate"),
      section("時期未設定", [row({ chapter: 2 })], "unassigned"),
    ]);

    const headings = markdown
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## 本編",
      "## IF・もし文佳が生きていたら",
      "## 時期未設定",
    ]);
  });

  it("時期ごとに見出しを立てて、表を分ける", () => {
    const markdown = chronicleToMarkdown([
      section("本編", [
        row({
          chapter: 3,
          chapterLabel: "第3話",
          timepoint: {
            id: "tp_001",
            label: "十年前・火事の夜",
            absolute: null,
            lineId: "ln_001",
          },
        }),
        row({
          timepoint: {
            id: "tp_002",
            label: "本編開始",
            absolute: "四月",
            lineId: "ln_001",
          },
        }),
      ]),
    ]);

    const headings = markdown
      .split("\n")
      .filter((line) => line.startsWith("### "));
    // 日付表記は任意項目。書いてあれば添える
    expect(headings).toEqual(["### 十年前・火事の夜", "### 本編開始（四月）"]);
    expect(markdown.split("\n").filter((line) => line.startsWith("| 話数")))
      .toHaveLength(2);
  });

  it("表の列は、話数・題・登場・出来事・あらすじ", () => {
    const markdown = chronicleToMarkdown([
      section("本編", [
        row({
          title: "はじまり",
          appeared: [{ id: "char_001", name: "太志" }],
          events: [
            {
              kind: "change",
              characterId: "char_001",
              characterName: "太志",
              text: "外見：黒髪 → 銀髪",
            },
          ],
          synopsis: "太志が港へ向かう。",
        }),
      ]),
    ]);

    expect(markdown).toContain("| 話数 | 題 | 登場 | 出来事 | あらすじ |");
    expect(markdown).toContain(
      "| 第1話 | はじまり | 太志 | 外見：黒髪 → 銀髪 | 太志が港へ向かう。 |"
    );
  });

  it("あらすじの改行と縦棒で、表を崩さない", () => {
    const markdown = chronicleToMarkdown([
      section("本編", [row({ synopsis: "一行目\n二行目|三行目" })]),
    ]);

    const line = markdown
      .split("\n")
      .find((entry) => entry.startsWith("| 第1話"));
    expect(line).toBe("| 第1話 |  |  |  | 一行目 二行目｜三行目 |");
  });

  it("どちらの並びを書き出したかが残る", () => {
    expect(
      chronicleToMarkdown([section("本編", [row()])], { order: "timeline" })
    ).toContain("並び：時系列順");
    expect(
      chronicleToMarkdown([section("本編", [row()])], {
        order: "chapter",
        workTitle: "夜の底",
      })
    ).toContain("# 年表（夜の底）");
  });
});
