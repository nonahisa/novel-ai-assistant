import { describe, expect, test } from "vitest";
import { checkWritingStyle } from "../../src/core/writingStyleCheck";
import type { Chunk } from "../../src/core/chunker";

function makeChunk(text: string, startLine = 0): Chunk {
  return {
    filePath: "C:\\work\\001.txt",
    index: 0,
    text,
    startLine,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "hash-1",
  };
}

describe("三点リーダー・ダッシュの偶数使用", () => {
  test("奇数個の三点リーダーを検出する", () => {
    const chunk = makeChunk("彼は…と呟いた。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "…");
    expect(found).toBeDefined();
    expect(found?.suggestion).toBe("……");
    expect(found?.confidence).toBe("medium");
  });

  test("偶数個（2個）は検出しない", () => {
    const chunk = makeChunk("彼は……と呟いた。");
    const findings = checkWritingStyle(chunk);
    expect(findings.find((f) => f.target.includes("…"))).toBeUndefined();
  });

  test("3個（奇数）も検出し、1個足す提案にする", () => {
    const chunk = makeChunk("彼は………と黙り込んだ。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "………");
    expect(found).toBeDefined();
    expect(found?.suggestion).toBe("…………");
  });

  test("奇数個のダッシュを検出する", () => {
    const chunk = makeChunk("突然―扉が開いた。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "―");
    expect(found).toBeDefined();
    expect(found?.suggestion).toBe("――");
  });

  test("偶数個のダッシュは検出しない", () => {
    const chunk = makeChunk("突然――扉が開いた。");
    const findings = checkWritingStyle(chunk);
    expect(findings.find((f) => f.target.includes("―"))).toBeUndefined();
  });
});

describe("鉤括弧内文末の句点", () => {
  test("「。」の組み合わせを検出し、句点を落とす提案にする", () => {
    const chunk = makeChunk("「これはテストだ。」と彼は言った。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "。」");
    expect(found).toBeDefined();
    expect(found?.suggestion).toBe("」");
  });

  test("『。』の組み合わせも検出する", () => {
    const chunk = makeChunk("『それは違う。』と反論した。");
    const findings = checkWritingStyle(chunk);
    expect(findings.find((f) => f.target === "。』")).toBeDefined();
  });

  test("句点が無ければ検出しない", () => {
    const chunk = makeChunk("「これはテストだ」と彼は言った。");
    const findings = checkWritingStyle(chunk);
    expect(findings.find((f) => f.target.includes("」"))).toBeUndefined();
  });
});

describe("感嘆符・疑問符後の空白", () => {
  test("後にスペースが無ければ検出する", () => {
    const chunk = makeChunk("何だって！本当か？困った。");
    const findings = checkWritingStyle(chunk);
    const marks = findings.filter((f) => f.reason.includes("感嘆符"));
    expect(marks).toHaveLength(2);
    expect(marks[0].target).toBe("！本");
    expect(marks[0].suggestion).toBe("！　本");
  });

  test("すでに全角スペースがあれば検出しない", () => {
    const chunk = makeChunk("何だって！　本当か？");
    const findings = checkWritingStyle(chunk);
    expect(findings.filter((f) => f.reason.includes("感嘆符"))).toHaveLength(0);
  });

  test("行末・閉じ括弧の直前・！？の連続は検出しない", () => {
    const chunk = makeChunk("「本当か！」　何だと！？　まさか！");
    const findings = checkWritingStyle(chunk);
    expect(findings.filter((f) => f.reason.includes("感嘆符"))).toHaveLength(0);
  });
});

describe("行番号とテスト対象外のルール", () => {
  test("startLineを基準に1始まりの行番号を付ける", () => {
    const chunk = makeChunk("見出し\n彼は…と呟いた。", 9);
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "…");
    expect(found?.line).toBe(11);
  });

  test("すべての指摘に「意図的な表現であれば無視」という文言が入る", () => {
    const chunk = makeChunk("彼は…と呟いた。「テストだ。」何だって！困った。");
    const findings = checkWritingStyle(chunk);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.reason).toContain("意図的な表現であれば無視してください");
    }
  });
});
