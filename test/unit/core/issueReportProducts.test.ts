import { describe, expect, test } from "vitest";
import { redactSecrets } from "../../../src/core/logger";
import {
  ISSUE_REPORT_FORMAT_LINE,
  SUMMARY_HEADINGS,
  buildIssueReport,
  isAuthorHint,
  type IssueReportInput,
} from "../../../src/core/issueReport";

/**
 * ほかの製品（モバイル版など）が同じ記録の形で書き出す口（1.1.0。母艦経由のモバイル版の頼み 2026-11-28）。
 * 環境の行の並び・再現手順の案内の例・「製品:」の行を呼ぶ側から渡せる。**渡さなければ統合の出力は1字も変わらない**
 */

const NOW = new Date(2026, 10, 28, 10, 0, 0);

function input(overrides: Partial<IssueReportInput> = {}, environment: Partial<IssueReportInput["environment"]> = {}): IssueReportInput {
  return {
    now: NOW,
    reportId: "NAI-20261128-ab12",
    rangeHours: 24,
    rangeLabel: "直近24時間",
    environment: {
      extensionVersion: "1.1.0",
      vscodeVersion: "1.105.0",
      os: "win32",
      browser: false,
      ais: [{ label: "既定", provider: "Ollama", model: "gemma4:e4b", local: true }],
      ...environment,
    },
    logs: [],
    redaction: {
      workRoot: undefined,
      storageRoot: undefined,
      homeDir: "C:\\Users\\someone",
      characters: [],
      workNames: [],
      maskNames: true,
      redactSecrets,
    },
    ...overrides,
  };
}

/** 環境の欄の行（見出しの下から、次の見出しの手前まで。空行は除く） */
function environmentLines(summary: string): string[] {
  const lines = summary.split("\n");
  const start = lines.indexOf(SUMMARY_HEADINGS.environment);
  const end = lines.indexOf(SUMMARY_HEADINGS.steps);
  return lines.slice(start + 1, end).filter((line) => line !== "");
}

describe("ほかの製品が同じ形で書き出す口", () => {
  test("何も渡さなければ、統合の環境の欄はこれまでと同じ行・同じ順（「製品:」の行は無い）", () => {
    expect(environmentLines(buildIssueReport(input()).summary)).toEqual([
      "報告ID: NAI-20261128-ab12",
      ISSUE_REPORT_FORMAT_LINE,
      "拡張機能: 1.1.0",
      "VS Code: 1.105.0",
      "OS: win32",
      "ブラウザ版: いいえ",
      "AI（既定）: Ollama / gemma4:e4b（手元）",
    ]);
  });

  test("製品の名前と版の行を渡すと、記録の形の次に「製品:」、その次に渡した行が入り、VS Code の行は入らない", () => {
    const report = buildIssueReport(input({}, { product: "モバイル版", lines: ["アプリ: 0.2.0", "Android: 15"] }));
    expect(environmentLines(report.summary)).toEqual([
      "報告ID: NAI-20261128-ab12",
      ISSUE_REPORT_FORMAT_LINE,
      "製品: モバイル版",
      "アプリ: 0.2.0",
      "Android: 15",
      "AI（既定）: Ollama / gemma4:e4b（手元）",
    ]);
  });

  test("渡した行も伏せ方を通る（作者のフォルダー名を外へ出さない）", () => {
    const report = buildIssueReport(input({}, { lines: ["置き場: C:\\Users\\someone\\作品"] }));
    expect(report.summary).not.toContain("someone");
  });

  test("再現手順の案内の例を替えられ、期待・実際の案内はそのまま", () => {
    const hint = "（ここに、押した操作を順に書いてください。例：右上のメニュー › ログ を押した）";
    const summary = buildIssueReport(input({ stepsHint: hint })).summary;
    const lines = summary.split("\n");
    expect(lines[lines.indexOf(SUMMARY_HEADINGS.steps) + 1]).toBe(hint);
    expect(lines[lines.indexOf(SUMMARY_HEADINGS.expected) + 1]).toBe("（ここに、どうなるはずだったかを書いてください）");
  });

  test("案内の一文が約束の形（「（ここに、」で始まり「）」で終わる1行）でなければ投げる", () => {
    expect(isAuthorHint("（ここに、書いてください）")).toBe(true);
    for (const bad of ["ここに書いてください", "（ここに、書いてください", "（ここに、一行目\n二行目）"]) {
      expect(isAuthorHint(bad), bad).toBe(false);
      expect(() => buildIssueReport(input({ stepsHint: bad })), bad).toThrow();
    }
  });
});
