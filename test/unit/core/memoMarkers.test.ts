import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMO_MARKERS,
  MemoMarkersConfigError,
  UnclosedMemoNoticeMemory,
  memoInsertOf,
  memoMarkersOf,
  resolveMemoMarkers,
} from "../../../src/core/memoMarkers";
import {
  blankMemoLines,
  isMemoLine,
  linesStartingWithMarkers,
  memoHint,
  memoLineRemoval,
  memoLineRestorePoint,
  parseMemos,
  removeMemoLine,
  restoreMemoLine,
  scanMemoLines,
  stripMemoLines,
  unclosedMemoCommentLine,
} from "../../../src/core/sceneMemo";
import * as workRegistry from "../../../src/core/workRegistry";
import type { WorkConfig } from "../../../src/models/types";
import { countChars, countManuscriptLines } from "../../../src/core/charCount";
import { convertForPosting } from "../../../src/core/postingConvert";
import { normalizePostingBody } from "../../../src/core/postingBodyHash";
import { toNoteMarkdown } from "../../../src/core/noteMarkdown";
import { buildChapterFragment, countParagraphs, splitParagraphs } from "../../../src/core/epubXhtml";
import { buildPrintHtml } from "../../../src/core/printHtml";
import { layoutGrid } from "../../../src/core/manuscriptGrid";
import { splitIntoChunks } from "../../../src/core/chunker";
import { hideMemoLinesInMarkdown } from "../../../src/core/markdownItRuby";

/**
 * メモの印を作品ごとに選べる（設計書6.40.8。作者の決定 2026-11-14 夜）。
 *
 * 新しい印（`\\`・`＼＼`・`￥￥`・`%%`・`％％`・囲み）が、**オンのときだけ**メモになり、
 * 字数・投稿用のコピー・EPUB・PDF・AI へ送る本文から外れること。オフのときは本文のまま。
 * 既定（設定ファイルが無い作品）は今と同じ（`//` と `／／` だけ）。
 */

const ALL = memoMarkersOf(["slash", "backslash", "percent", "comment"]);
const PERCENT_ONLY = memoMarkersOf(["percent"]);
const COMMENT_ONLY = memoMarkersOf(["comment"]);

/** 新しい印の見本。どれも「行の頭の空白のあと」に印がある */
const NEW_MARKER_LINES = [
  "\\\\ 半角のバックスラッシュ",
  "＼＼ 全角のバックスラッシュ",
  "￥￥ 全角の円記号",
  "%% 半角の百分率",
  "　％％ 字下げした全角の百分率",
  "<!-- 1行で閉じた囲み -->",
];

describe("印の判定（scanMemoLines）", () => {
  it("新しい印は、オンのときだけメモ。既定ではどれも本文", () => {
    for (const line of NEW_MARKER_LINES) {
      expect(isMemoLine(line, ALL), line).toBe(true);
      expect(isMemoLine(line), line).toBe(false);
      expect(isMemoLine(line, DEFAULT_MEMO_MARKERS), line).toBe(false);
    }
    // 既定は今と同じ
    expect(isMemoLine("// メモ")).toBe(true);
    expect(isMemoLine("　／／字下げ")).toBe(true);
    expect(isMemoLine("URL は http://example")).toBe(false);
  });

  it("`//` を外して `%%` だけにした作品では、`//` の行は本文", () => {
    expect(isMemoLine("// 本文の中の斜線", PERCENT_ONLY)).toBe(false);
    expect(isMemoLine("%% メモ", PERCENT_ONLY)).toBe(true);
    expect(isMemoLine("¥¥ これも同じ字", memoMarkersOf(["backslash"]))).toBe(false);
  });

  it("囲みは `<!--` の行から `-->` を含む行まで。複数行でもよい", () => {
    const lines = ["本文一", "<!-- TODO 書き足す", "二行目", "三行目 -->", "本文二"];
    const scan = scanMemoLines(lines, COMMENT_ONLY);
    expect(scan.memo).toEqual([false, true, true, true, false]);
    expect(scan.blocks).toEqual([{ start: 1, end: 3, comment: true }]);
    expect(scan.unclosedLine).toBeNull();
  });

  it("`-->` のあとに字があるのは閉じ忘れと同じ扱い（本文を消さない）", () => {
    const lines = ["<!-- メモ", "--> ここから本文", "本文"];
    const scan = scanMemoLines(lines, COMMENT_ONLY);
    expect(scan.memo).toEqual([false, false, false]);
    expect(scan.unclosedLine).toBe(0);
  });

  it("閉じていない `<!--` からあとはメモにしない。1行の印はそのあとも効く", () => {
    const lines = ["本文", "<!-- 閉じ忘れ", "本文のまま", "%% 付箋"];
    const scan = scanMemoLines(lines, memoMarkersOf(["comment", "percent"]));
    expect(scan.memo).toEqual([false, false, false, true]);
    expect(scan.unclosedLine).toBe(1);
    expect(unclosedMemoCommentLine(lines.join("\n"), COMMENT_ONLY)).toBe(2);
    // 囲みがオフなら閉じ忘れも無い
    expect(unclosedMemoCommentLine(lines.join("\n"))).toBeNull();
  });

  it("閉じ損ねた囲みのあとは、正しく閉じた囲みもメモにしない（どこが対なのか決められない）", () => {
    const lines = ["<!-- 一", "-->のあとに字", "<!-- 二 -->", "本文"];
    const scan = scanMemoLines(lines, COMMENT_ONLY);
    expect(scan.memo).toEqual([false, false, false, false]);
    expect(scan.unclosedLine).toBe(0);
  });

  it("囲みの中に `<!--` がもう1つあっても、最初の `-->` で閉じる", () => {
    const scan = scanMemoLines(["<!-- 外", "<!-- 中 -->", "本文"], COMMENT_ONLY);
    expect(scan.memo).toEqual([true, true, false]);
  });
});

describe("付箋の一覧（parseMemos）", () => {
  it("囲みの1件を1つの付箋にし、タグは最初の行から読む", () => {
    const text = "本文\r\n<!-- 伏線 港の灯\r\nまだ続く -->\r\n本文";
    const memos = parseMemos(text, "a.txt", COMMENT_ONLY);
    expect(memos).toEqual([
      {
        filePath: "a.txt",
        line: 2,
        endLine: 3,
        tag: "伏線",
        text: "港の灯 まだ続く",
        raw: "<!-- 伏線 港の灯\r\nまだ続く -->",
      },
    ]);
  });

  it("1行の囲みと新しい印も付箋になる。オフなら1件も無い", () => {
    const text = "<!-- TODO 足す -->\n%% 確認 時刻\n\\\\ アイデア 灯台";
    expect(parseMemos(text, "", ALL).map((memo) => [memo.tag, memo.text])).toEqual([
      ["TODO", "足す"],
      ["確認", "時刻"],
      ["アイデア", "灯台"],
    ]);
    expect(parseMemos(text)).toEqual([]);
  });

  it("［済み］は囲み全体を消し、［戻す］で元へ戻る", () => {
    const text = "一\n<!-- TODO\n二行目 -->\n三";
    const memo = parseMemos(text, "", COMMENT_ONLY)[0];
    const removed = memoLineRemoval(text, memo.line, memo.raw, COMMENT_ONLY);
    expect(removed?.lineCount).toBe(2);
    const after = removeMemoLine(text, memo.line, memo.raw, COMMENT_ONLY);
    expect(after).toBe("一\n三");
    expect(memoLineRestorePoint(after ?? "", removed!)).not.toBeNull();
    expect(restoreMemoLine(after ?? "", removed!)).toBe(text);
    // 印の組が違えば消さない（作品の印を外したあとの古い一覧から押された）
    expect(removeMemoLine(text, memo.line, memo.raw)).toBeNull();
  });
});

describe("字数・投稿用・書き出し・AIの入力から外れる", () => {
  const body = ["　本文の一行目。", "%% 作者のメモ", "<!-- 囲みの", "メモ -->", "　本文の二行目。"].join("\n");
  const markers = memoMarkersOf(["percent", "comment"]);

  it("字数と原稿用紙の行数", () => {
    const plain = "　本文の一行目。\n　本文の二行目。";
    expect(countChars(body, true, markers)).toEqual(countChars(plain));
    expect(countManuscriptLines(body, true, markers)).toBe(countManuscriptLines(plain));
    // オフなら本文として数える
    expect(countChars(body).gross).toBeGreaterThan(countChars(plain).gross);
  });

  it("投稿用のコピーと、投稿の照合の正規化", () => {
    const target = { site: "kakuyomu", style: "site", emphasis: "kakuyomu" } as unknown as Parameters<
      typeof convertForPosting
    >[1];
    const out = convertForPosting(body, target, { memoMarkers: markers }).text;
    expect(out).not.toContain("作者のメモ");
    expect(out).not.toContain("囲みの");
    expect(convertForPosting(body, target).text).toContain("作者のメモ");
    expect(normalizePostingBody(body, markers)).not.toContain("メモ");
    expect(normalizePostingBody(body)).toContain("作者のメモ");
  });

  it("note へのコピー", () => {
    expect(toNoteMarkdown(body, { memoMarkers: markers }).body).not.toContain("メモ");
    expect(toNoteMarkdown(body).body).toContain("作者のメモ");
  });

  it("EPUB", () => {
    expect(splitParagraphs(body, markers).join("")).not.toContain("メモ");
    expect(countParagraphs(body, markers)).toBe(1);
    const chapter = { heading: "第1話", body, notation: "curly" } as Parameters<typeof buildChapterFragment>[0];
    expect(buildChapterFragment(chapter, { collapseBlankLines: false, memoMarkers: markers })).not.toContain(
      "作者のメモ"
    );
    expect(buildChapterFragment(chapter, { collapseBlankLines: false })).toContain("作者のメモ");
  });

  it("PDF（読み物の紙と、原稿用紙の升目）", () => {
    const html = buildPrintHtml({
      workTitle: "作品",
      episodes: [{ heading: "第1話", body, notation: "curly" }],
      preset: "a5-vertical",
      memoMarkers: markers,
    });
    expect(html).not.toContain("作者のメモ");
    expect(html).not.toContain("囲みの");
    const pages = layoutGrid([{ heading: "第1話", body, notation: "curly" }], {
      columns: 20,
      rows: 20,
      hanging: true,
      vertical: true,
      memoMarkers: markers,
    });
    const cells = JSON.stringify(pages);
    expect(cells).not.toContain("作");
    expect(cells).toContain("一");
  });

  it("AIへ送る本文（行数は保つ）", () => {
    const blanked = blankMemoLines(body, markers);
    expect(blanked.split("\n")).toHaveLength(5);
    expect(blanked).not.toContain("メモ");
    const chunks = splitIntoChunks("a.txt", body, 1, 1, { memoMarkers: markers });
    expect(chunks.map((chunk) => chunk.text).join("")).not.toContain("メモ");
    expect(splitIntoChunks("a.txt", body, 1, 1).map((chunk) => chunk.text).join("")).toContain("作者のメモ");
  });

  it("Markdown のプレビュー", () => {
    expect(hideMemoLinesInMarkdown(body, markers)).not.toContain("メモ");
    expect(stripMemoLines(body, markers)).toBe("　本文の一行目。\n　本文の二行目。");
  });

  it("閉じ忘れの囲みは、どの出力でも本文のまま", () => {
    const broken = "　本文。\n<!-- 閉じ忘れ\n　続きの本文。";
    expect(stripMemoLines(broken, COMMENT_ONLY)).toBe(broken);
    expect(countChars(broken, true, COMMENT_ONLY)).toEqual(countChars(broken));
  });
});

describe("設定の欄の読み方（resolveMemoMarkers）", () => {
  it("欄が無ければ既定。名前の並びならその印。知らない名前は飛ばす", () => {
    expect(resolveMemoMarkers(undefined)).toEqual(DEFAULT_MEMO_MARKERS);
    expect(resolveMemoMarkers(["percent", "slash"]).ids).toEqual(["slash", "percent"]);
    expect(resolveMemoMarkers(["percent", "future"]).ids).toEqual(["percent"]);
  });

  it("壊れた欄は直さずに止める（黙って既定へ戻すと、選んだ印の行が投稿に出る）", () => {
    expect(() => resolveMemoMarkers("percent")).toThrow(MemoMarkersConfigError);
    expect(() => resolveMemoMarkers([1])).toThrow(MemoMarkersConfigError);
    expect(() => resolveMemoMarkers([])).toThrow(MemoMarkersConfigError);
    expect(() => resolveMemoMarkers(["unknown"])).toThrow(MemoMarkersConfigError);
  });

  it("挿す印と案内は、オンの印のうち最初のもの", () => {
    expect(memoInsertOf(DEFAULT_MEMO_MARKERS)).toEqual({ prefix: "// ", suffix: "" });
    expect(memoInsertOf(PERCENT_ONLY)).toEqual({ prefix: "%% ", suffix: "" });
    expect(memoInsertOf(COMMENT_ONLY)).toEqual({ prefix: "<!-- ", suffix: " -->" });
    expect(memoHint()).toBe("本文の行頭に // と書くとメモになります（字下げしていても構いません）");
    expect(memoHint(memoMarkersOf(["percent", "comment"]))).toContain("%%");
    expect(memoHint(memoMarkersOf(["percent", "comment"]))).toContain("<!--");
  });
});

describe("切り替える前の数え上げ（linesStartingWithMarkers）", () => {
  it("新しくオンにする印で始まる行を数える。囲みは `<!--` で始まる行", () => {
    const text = "本文\n%% 一\n　％％ 二\n<!-- 閉じ忘れでも数える\n// 既にオン";
    expect(linesStartingWithMarkers(text, memoMarkersOf(["percent"]))).toEqual([2, 3]);
    expect(linesStartingWithMarkers(text, memoMarkersOf(["comment"]))).toEqual([4]);
  });
});

describe("保存の閉じ忘れの知らせの覚え（UnclosedMemoNoticeMemory）", () => {
  it("同じ話・同じ場所では2回出さない。場所が変われば、また出す", () => {
    const memory = new UnclosedMemoNoticeMemory();
    expect(memory.shouldNotify("a.txt", 3)).toBe(true);
    expect(memory.shouldNotify("a.txt", 3)).toBe(false);
    expect(memory.shouldNotify("a.txt", 5)).toBe(true);
    // 別の話は別に覚える
    expect(memory.shouldNotify("b.txt", 3)).toBe(true);
    expect(memory.shouldNotify("a.txt", 5)).toBe(false);
  });

  it("閉じたら覚えを捨て、あとでまた同じ場所で閉じ忘れたら、また知らせる", () => {
    const memory = new UnclosedMemoNoticeMemory();
    expect(memory.shouldNotify("a.txt", 3)).toBe(true);
    expect(memory.shouldNotify("a.txt", null)).toBe(false);
    expect(memory.shouldNotify("a.txt", 3)).toBe(true);
  });

  it("閉じ忘れの無い話では出さない", () => {
    expect(new UnclosedMemoNoticeMemory().shouldNotify("a.txt", null)).toBe(false);
  });
});

describe("作品設定の memoMarkers 欄（parseWorkConfig）", () => {
  const parseWorkConfig = (
    workRegistry as unknown as { parseWorkConfig: (raw: unknown) => WorkConfig }
  ).parseWorkConfig;
  const base = {
    schemaVersion: "0.1",
    workTitle: "テスト作品",
    manuscriptDir: "本文",
    settingsDir: "設定",
    createdAt: "2026-11-14T00:00:00.000Z",
  };

  it("欄が無ければ欄を足さず、名前の並びならそのまま残す（知らない名前も消さない）", () => {
    expect(parseWorkConfig(base).memoMarkers).toBeUndefined();
    expect(parseWorkConfig({ ...base, memoMarkers: ["percent", "future"] }).memoMarkers).toEqual([
      "percent",
      "future",
    ]);
  });

  it("壊れた欄では直さずに止める", () => {
    for (const broken of ["percent", [1], [], ["unknown"], { slash: true }]) {
      expect(() => parseWorkConfig({ ...base, memoMarkers: broken })).toThrow(MemoMarkersConfigError);
    }
  });
});
