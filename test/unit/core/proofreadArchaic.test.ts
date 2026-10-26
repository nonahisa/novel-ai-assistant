import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { validateProofreadIssues } from "../../../src/core/proofreadValidation";
import { collectWorkStyle } from "../../../src/core/workStyleFacts";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 文語調の作品では、漢字ひらきの提案を出さない（プロンプト設計書 P-10、設計書6.9.1）。
 *
 * 決まりはプロンプトの一文と文体メモにしか無く、gemma4:e4b が3件・26b が5件、
 * 文語の台で漢字ひらきを出して検算も通った（docs/measurements/2026-10-26-proofread-literary.md）。
 * **頼み方では止まらないので検算で落とす。** 文語かどうかは文体メモと同じ判定
 * （`collectWorkStyle` の `archaic`）を、作品全体の本文で取る。
 */

const SEEDED = resolve(__dirname, "../../fixtures/seeded");

function readEpisode(work: string, file: string): string {
  return readFileSync(resolve(SEEDED, work, "本文", file), "utf8");
}

function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/001.txt",
    index: 0,
    text,
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "abc123",
    segments: [],
  } as unknown as Chunk;
}

/** 原文がある行（1始まり。`startLine: 0` のチャンクの通し番号） */
function lineOf(text: string, original: string): number {
  const at = text.indexOf(original);
  if (at < 0) throw new Error(`台に「${original}」がありません`);
  return text.slice(0, at).split("\n").length;
}

function opening(text: string, original: string, suggestion: string) {
  return {
    line: lineOf(text, original),
    original,
    suggestion,
    reason: "漢字ひらき",
    explanation: "ひらがなにすると読みやすくなります",
    confidence: "medium",
  };
}

/** 製品と同じく、全話を繋いで文語かを決める */
function archaicOf(work: string, files: string[]): boolean {
  return collectWorkStyle({
    bodyText: files.map((file) => readEpisode(work, file)).join("\n"),
    narrativePerson: "",
    keepWords: [],
  }).archaic;
}

describe("文語調の作品の漢字ひらき", () => {
  const work = "proofread-literary";
  const files = ["001_岬の家.txt", "002_嵐.txt", "003_旅立ち.txt"];
  const archaic = archaicOf(work, files);

  test("台は文語と判定される（前提）", () => {
    expect(archaic).toBe(true);
  });

  // 26b が実際に出して検算を通った5件（測定の記録）
  test("測定で通った漢字ひらきをすべて落とす", () => {
    const cases: Array<[string, string, string]> = [
      ["001_岬の家.txt", "殆ど言葉を発する", "ほとんど言葉を発する"],
      ["002_嵐.txt", "恐らくは", "おそらくは"],
      ["003_旅立ち.txt", "然し之を", "しかし之を"],
      ["003_旅立ち.txt", "又、何時にても", "また、何時にても"],
      ["003_旅立ち.txt", "所謂故郷", "いわゆる故郷"],
    ];
    for (const [file, original, suggestion] of cases) {
      const text = readEpisode(work, file);
      const result = validateProofreadIssues(
        { issues: [opening(text, original, suggestion)] },
        chunkOf(text),
        [],
        null,
        archaic
      );
      expect(result.accepted, original).toEqual([]);
      expect(result.rejected.map((entry) => entry.reason), original).toEqual([
        "archaic_work",
      ]);
    }
  });

  // e4b の形：修正案が空で、本文に無い語を理由にした漢字ひらき。
  // ひらく語の一覧に無い語でも、文語の作品では札ごと出さない
  test("修正案が空の漢字ひらきも落とす", () => {
    const text = readEpisode(work, "001_岬の家.txt");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            ...opening(text, "過ごしたる", ""),
            explanation: "「過ごしたる」は読みにくい表記です",
          },
        ],
      },
      chunkOf(text),
      [],
      null,
      archaic
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "archaic_work",
    ]);
  });

  test("ほかの札は文語の作品でも今までどおり見る", () => {
    const text = readEpisode(work, "001_岬の家.txt");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: lineOf(text, "殆ど言葉を発する"),
            original: "殆ど言葉を発する",
            suggestion: "",
            reason: "同語反復",
            explanation: "「殆ど」が繰り返されています",
            confidence: "low",
          },
        ],
      },
      chunkOf(text),
      [],
      null,
      archaic
    );
    // 文語の規則ではなく、同語反復の検算で落ちる
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "not_repeated",
    ]);
  });
});

describe("口語の作品の漢字ひらき", () => {
  const work = "proofread-plain";
  const files = ["001_放課後.txt", "002_図書館.txt", "003_祖父の日誌.txt"];

  test("口語の台は文語と判定されず、漢字ひらきは今までどおり通る", () => {
    const archaic = archaicOf(work, files);
    expect(archaic).toBe(false);
    const text = readEpisode(work, "001_放課後.txt");
    const result = validateProofreadIssues(
      {
        issues: [
          opening(text, "暫く誰も来なかった", "しばらく誰も来なかった"),
          opening(text, "又、あの店で", "また、あの店で"),
        ],
      },
      chunkOf(text),
      [],
      null,
      archaic
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((issue) => issue.original)).toEqual([
      "暫く誰も来なかった",
      "又、あの店で",
    ]);
  });

  test("文語と言わなければ、今までどおり通る（引数を省いた呼び方）", () => {
    const text = readEpisode("proofread-literary", "003_旅立ち.txt");
    const result = validateProofreadIssues(
      { issues: [opening(text, "所謂故郷", "いわゆる故郷")] },
      chunkOf(text)
    );
    expect(result.accepted.map((issue) => issue.original)).toEqual([
      "所謂故郷",
    ]);
  });
});
