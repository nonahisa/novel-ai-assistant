import { describe, expect, test } from "vitest";
import {
  kindLineClass,
  kindLineCss,
  kindLineRules,
} from "../../../src/core/kindLines";
import {
  SCRIPT_LINE_CSS,
  scriptLineClass,
} from "../../../src/core/scriptLines";
import { buildPrintHtml } from "../../../src/core/printHtml";
import {
  buildChapterFragment,
  type EpubBodyOptions,
} from "../../../src/core/epubXhtml";
import { buildEpubCss } from "../../../src/core/epubPackage";
import { convertForPosting } from "../../../src/core/postingConvert";
import { postingCopyTargetFor } from "../../../src/core/postingCopyTargets";

/**
 * 種類ごとの行の組み方（設計書6.109 ③④）。
 *
 * **小説では規則もCSSも空**——原稿エディタ・PDF・EPUB のどれも、
 * 種類を渡さないときと1バイトも変わらない。組み方は印（class）だけで、
 * 本文の文字は1字も変えない（規則1）。
 */

describe("小説", () => {
  test("規則もCSSも空", () => {
    expect(kindLineRules("novel")).toEqual([]);
    expect(kindLineRules(undefined)).toEqual([]);
    expect(kindLineCss("novel")).toBe("");
    expect(kindLineClass("novel", "○駅前")).toBe("");
  });
});

describe("台本", () => {
  test("規則は core/scriptLines.ts のものと同じ答えを返す（写しを作らない）", () => {
    for (const line of ["○駅前・夜", "　ドアを開ける。", "太郎「行こう」", "地の文。", ""]) {
      expect(kindLineClass("script", line), line).toBe(scriptLineClass(line));
    }
    expect(kindLineCss("script")).toBe(SCRIPT_LINE_CSS);
  });
});

describe("漫画の原作", () => {
  test("ページ・コマ・絵の説明・台詞を見分ける", () => {
    expect(kindLineClass("manga", "■1ページ")).toBe("manga-page");
    expect(kindLineClass("manga", "□コマ1")).toBe("manga-panel");
    expect(kindLineClass("manga", "　教室の全景")).toBe("script-togaki");
    expect(kindLineClass("manga", "太郎「おはよう」")).toBe("script-serifu");
    expect(kindLineClass("manga", "地の文。")).toBe("");
  });

  test("台本のト書き・台詞の組み方も一緒に入る（同じ class を付けるため）", () => {
    expect(kindLineCss("manga")).toContain(SCRIPT_LINE_CSS);
    expect(kindLineCss("manga")).toContain(".manga-page");
  });
});

describe("エッセイ・記事", () => {
  test("行頭の■と Markdown の見出しを見出しにする", () => {
    expect(kindLineClass("essay", "■はじめに")).toBe("essay-heading");
    expect(kindLineClass("essay", "## はじめに")).toBe("essay-heading");
    // 見出しの印が無い行・4段以上の見出しは本文のまま
    expect(kindLineClass("essay", "本文。")).toBe("");
    expect(kindLineClass("essay", "#タグ")).toBe("");
  });
});

describe("歌詞・詩", () => {
  test("行ぜんたいが【…】の行だけを札にする", () => {
    expect(kindLineClass("lyrics", "【サビ】")).toBe("lyrics-label");
    expect(kindLineClass("lyrics", "【サビ】のあとの言葉")).toBe("");
  });
});

const SCRIPT_BODY = ["○駅前・夜", "", "　太郎、ドアを開ける。", "太郎「行こう」"].join("\n");
const MANGA_BODY = ["■1ページ", "□コマ1", "　教室", "太郎「よう」"].join("\n");

describe("PDF（④）", () => {
  function print(kind: Parameters<typeof kindLineCss>[0], body: string): string {
    return buildPrintHtml({
      workTitle: "作品",
      episodes: [{ heading: "第1話", body, notation: "curly" }],
      preset: "a4-horizontal",
      kind,
    });
  }

  test("漫画の原作は、ページ・コマに印が付き、組み方が入る", () => {
    const out = print("manga", MANGA_BODY);
    expect(out).toContain('<p class="manga-page">');
    expect(out).toContain('<p class="manga-panel">');
    expect(out).toContain(kindLineCss("manga"));
  });

  test("小説の紙は、種類を渡さないときと1バイトも変わらない", () => {
    expect(print("novel", SCRIPT_BODY)).toBe(print(undefined, SCRIPT_BODY));
  });
});

describe("EPUB（④）", () => {
  const base: EpubBodyOptions = { collapseBlankLines: false };
  const chapter = (body: string) => ({ heading: "第1話", body, notation: "curly" as const });

  test("台本は、柱・ト書き・台詞に印が付く", () => {
    const out = buildChapterFragment(chapter(SCRIPT_BODY), { ...base, kind: "script" });
    expect(out).toContain('<p class="script-hashira">');
    expect(out).toContain('<p class="script-togaki">');
    expect(out).toContain('<p class="script-serifu">');
  });

  test("本文の文字は1字も変わらない（印が付くだけ）", () => {
    const plain = buildChapterFragment(chapter(SCRIPT_BODY), base);
    const marked = buildChapterFragment(chapter(SCRIPT_BODY), { ...base, kind: "script" });
    const text = (html: string) => html.replace(/<[^>]*>/g, "");
    expect(text(marked)).toBe(text(plain));
  });

  test("小説の本文とCSSは、種類を渡さないときと1バイトも変わらない", () => {
    expect(buildChapterFragment(chapter(SCRIPT_BODY), { ...base, kind: "novel" })).toBe(
      buildChapterFragment(chapter(SCRIPT_BODY), base)
    );
    expect(buildEpubCss(true, {}, {}, "novel")).toBe(buildEpubCss(true));
  });

  test("CSSに種類の組み方が入る（原稿エディタ・PDFと同じ文字列）", () => {
    expect(buildEpubCss(true, {}, {}, "script")).toContain(SCRIPT_LINE_CSS);
  });

  test("改ページの印と種類の印は両方付く", () => {
    const out = buildChapterFragment(chapter(["地の文。", "", "○駅前"].join("\n")), {
      ...base,
      kind: "script",
      pageBreaks: [1],
    });
    expect(out).toMatch(/<p class="[^"]*\bscript-hashira\b[^"]*">/);
    expect(out).toMatch(/<p class="[^"]*page-break[^"]*script-hashira"/);
  });
});

describe("投稿用の変換（④）", () => {
  /**
   * 投稿サイトの本文欄は文字だけで、組み方は持てない。**台本の書式
   * （柱の ○・ト書きの全角空白・役名「台詞」）が1字も崩れずに届く**ことが、
   * ここでの「種類に合った組み方」になる。
   */
  test("台本・漫画の原作の行は、どのサイト向けでもそのまま届く", () => {
    // note は Markdown として整え直す別の道（段落の作り方が違う）なので、
    // 本文をそのまま貼る3サイトで確かめる
    for (const site of ["narou", "kakuyomu", "alphapolis"] as const) {
      const target = postingCopyTargetFor(site);
      for (const body of [SCRIPT_BODY, MANGA_BODY]) {
        expect(convertForPosting(body, target).text, site).toBe(body);
      }
    }
  });
});
