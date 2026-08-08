import { describe, expect, test } from "vitest";
import {
  IGNORED_PATHS,
  missingIgnoreRules,
} from "../../src/core/workRegistry";

const encode = (text: string) => new TextEncoder().encode(text);

describe("同期対象から外す規則", () => {
  test("キャッシュを必ず除外する", () => {
    // 設計書3.5.7。以前は登録した作品で漏れており、
    // キャッシュがGitに入ったままだった
    expect(IGNORED_PATHS).toContain(".aiwriter/cache/");
  });

  test("設定資料と承認待ちは除外しない", () => {
    // 別の環境でも読みたい・承認したいので同期する
    expect(IGNORED_PATHS).not.toContain(".aiwriter/pending-characters/");
    expect(IGNORED_PATHS.join("\n")).not.toContain("設定/");
  });

  test("空の.gitignoreには全部足りない", () => {
    expect(missingIgnoreRules(encode(""))).toEqual([...IGNORED_PATHS]);
  });

  test("既にある規則は重ねて足さない", () => {
    const existing = encode(".novelai-recovery/\n.aiwriter/cache/\n");

    expect(missingIgnoreRules(existing)).toEqual([
      ".aiwriter/logs/",
      ".aiwriter/exports/",
      "exports/",
    ]);
  });

  test("全部そろっていれば追記しない", () => {
    const existing = encode(IGNORED_PATHS.join("\n"));

    expect(missingIgnoreRules(existing)).toEqual([]);
  });

  test("CRLFでも前後の空白があっても認識する", () => {
    const existing = encode("  .aiwriter/cache/  \r\n.novelai-recovery/\r\n");

    expect(missingIgnoreRules(existing)).not.toContain(".aiwriter/cache/");
    expect(missingIgnoreRules(existing)).not.toContain(".novelai-recovery/");
  });

  test("作者が書いた行は判定に影響しない", () => {
    const existing = encode("# 作者のメモ\n*.bak\n下書き/\n");

    expect(missingIgnoreRules(existing)).toEqual([...IGNORED_PATHS]);
  });
});
