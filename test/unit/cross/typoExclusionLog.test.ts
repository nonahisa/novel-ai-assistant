import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { window } from "./support/vscodeStub";
import { disposeLog } from "../../src/core/logger";
import { appliedFixKey } from "../../src/core/typoIssueHistory";
import type { Chunk } from "../../src/core/chunker";
import type { TypoCheckResult } from "../../src/prompts/typoCheck";

const { collectIssues } = await import("../../src/features/checkTypos");

/**
 * 誤字脱字検知で落とした指摘の、理由をログへ残す（設計書6.8）。
 *
 * **実機で「指摘 1件 / 除外 1件」と出たのに、提案パネルは「誤字脱字 0件」
 * だった**（2026-09-06、作者の報告）。落ちる道が3つ——検証の不採用・
 * 行を元のファイルへ戻せない・前回適用済み——あるのに、**どれで落ちたのかが
 * ログにも通知にも残っていなかった**ため、追いようがなかった。
 *
 * ここでは「落とした理由が操作ログに残ること」だけを見る。
 * 通知の文面は `checkRunCounts.test.ts` が見る。
 */

const FILE = "C:/works/試しの作品/原稿/01.txt";

/** まとめていない、ふつうの1話ぶんのチャンク */
function singleChunk(text: string): Chunk {
  return {
    filePath: FILE,
    index: 0,
    text,
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "chunk-1",
  };
}

function response(issues: TypoCheckResult["issues"]): TypoCheckResult {
  return { issues };
}

/** ログへ出た行 */
let logged: string[] = [];

const stub = window as unknown as Record<string, unknown>;
const originalCreateOutputChannel = stub.createOutputChannel;

beforeEach(() => {
  logged = [];
  stub.createOutputChannel = () => ({
    appendLine: (line: string) => logged.push(line),
    show() {},
    dispose() {},
  });
});

afterEach(() => {
  // ログの出力先は module 側に覚えられているので、捨ててから戻す
  disposeLog();
  stub.createOutputChannel = originalCreateOutputChannel;
});

describe("落とした指摘の理由を残す", () => {
  /**
   * **これが実機で起きた形である。** 返ってきた1件が前回適用済みで、
   * 一覧へは何も出ない。通知が「指摘 1件」と言えば、作者は
   * 「1件見つかったのに一覧が空」と受け取る。
   */
  test("前回適用済みで落としたぶんは、指摘に数えず件数をログへ残す", () => {
    const out: unknown[] = [];
    const tally = collectIssues(
      response([
        {
          line: 1,
          original: "明日わ雨らしい。",
          target: "明日わ",
          suggestion: "明日は",
          reason: "助詞の誤り",
          confidence: "high",
        },
      ]),
      singleChunk("明日わ雨らしい。\nそれでも歩く。"),
      [],
      [],
      new Set<string>(),
      new Set([appliedFixKey("01.txt", "明日は", "明日わ")]),
      out as never[]
    );

    expect(out).toHaveLength(0);
    expect(tally).toEqual({ rejected: 0, alreadyApplied: 1 });
    const text = logged.join("\n");
    expect(text).toContain("前回適用済み");
    expect(text).toContain("1件");
  });

  test("検証の不採用は、理由ごとの内訳をログへ残す", () => {
    const out: unknown[] = [];
    const tally = collectIssues(
      response([
        // 行番号がチャンクの外
        {
          line: 99,
          original: "明日わ雨らしい。",
          target: "明日わ",
          suggestion: "明日は",
          reason: "助詞の誤り",
          confidence: "high",
        },
        // 本文に無い文を「引用」してきた
        {
          line: 1,
          original: "存在しない一文である。",
          target: "存在",
          suggestion: "実在",
          reason: "誤変換",
          confidence: "high",
        },
      ]),
      singleChunk("明日わ雨らしい。\nそれでも歩く。"),
      [],
      [],
      new Set<string>(),
      new Set<string>(),
      out as never[]
    );

    expect(out).toHaveLength(0);
    expect(tally.rejected).toBe(2);
    const text = logged.join("\n");
    // **内訳まで残す。** 総数だけでは「消しすぎ」なのか「本当に無い」のか
    // 分からない（誤字脱字は64件中62件が素通りしたことがある）
    expect(text).toContain("行番号が範囲外 1件");
    expect(text).toContain("本文に無い引用 1件");
  });

  test("行を元のファイルへ戻せなかったものは、AIの行番号をログへ残す", () => {
    // **まとめたチャンクの、どの話にも属さない行。** 内訳の隙間に落ちる行は
    // 元のファイルを決められないので捨てるしかないが、黙って捨てない
    const text = "第一話\n明日わ雨らしい。\nおわり";
    const chunk: Chunk = {
      filePath: FILE,
      index: 0,
      text,
      startLine: 0,
      chapterStart: 1,
      chapterEnd: 2,
      hash: "chunk-2",
      segments: [
        {
          filePath: FILE,
          chapterStart: 1,
          chapterEnd: 1,
          start: 0,
          end: 3,
          startLine: 0,
        },
        {
          filePath: "C:/works/試しの作品/原稿/02.txt",
          chapterStart: 2,
          chapterEnd: 2,
          start: 13,
          end: 16,
          startLine: 0,
        },
      ],
    };

    const out: unknown[] = [];
    const tally = collectIssues(
      response([
        {
          line: 2,
          original: "明日わ雨らしい。",
          target: "明日わ",
          suggestion: "明日は",
          reason: "助詞の誤り",
          confidence: "high",
        },
      ]),
      chunk,
      [],
      [],
      new Set<string>(),
      new Set<string>(),
      out as never[]
    );

    expect(out).toHaveLength(0);
    expect(tally.rejected).toBe(1);
    expect(logged.join("\n")).toContain("行番号 2");
  });

  test("通った指摘は、そのまま渡す（ログは出さない）", () => {
    const out: unknown[] = [];
    const tally = collectIssues(
      response([
        {
          line: 1,
          original: "明日わ雨らしい。",
          target: "明日わ",
          suggestion: "明日は",
          reason: "助詞の誤り",
          confidence: "high",
        },
      ]),
      singleChunk("明日わ雨らしい。\nそれでも歩く。"),
      [],
      [],
      new Set<string>(),
      new Set<string>(),
      out as never[]
    );

    expect(out).toHaveLength(1);
    expect(tally).toEqual({ rejected: 0, alreadyApplied: 0 });
    expect(logged.join("\n")).not.toContain("除外");
  });
});
