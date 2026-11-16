import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ASSIGNABLE_FEATURE_LABELS,
  ASSIGNABLE_FEATURES,
  decideFeatureAI,
  withAssignment,
  withoutAssignment,
  type FeatureAssignments,
} from "../../../src/core/featureAssignment";

/**
 * 機能ごとのAIの割り当ての決め方（`core/featureAssignment.ts`）。
 *
 * モバイル版も同じ部品を使うので、`AIRegistry` を通さずにここだけで確かめる
 * （`AIRegistry` を通した確かめは `test/unit/ai/featureAssignments.test.ts`）。
 */

const DEFAULT = { provider: "gemini", model: "gemini-pro" };
const usableAll = (): boolean => true;

describe("decideFeatureAI", () => {
  test("割当が無い機能は既定のAIを使う", () => {
    expect(decideFeatureAI("typo", {}, DEFAULT, usableAll)).toEqual({
      choice: { provider: "gemini", model: "gemini-pro" },
    });
  });

  test("割当があり使えるなら割当を使う", () => {
    const assignments: FeatureAssignments = { typo: { provider: "ollama", model: "gemma4:e4b" } };
    expect(decideFeatureAI("typo", assignments, DEFAULT, usableAll)).toEqual({
      choice: { provider: "ollama", model: "gemma4:e4b" },
    });
  });

  test("割当が使えないときは既定へ落とし、落とした元を返す（止めない）", () => {
    const assignments: FeatureAssignments = { typo: { provider: "ollama", model: "gemma4:e4b" } };
    const decided = decideFeatureAI("typo", assignments, DEFAULT, (p) => p !== "ollama");
    expect(decided).toEqual({ choice: DEFAULT, fellBackFrom: "ollama" });
  });

  test("割当が使えず既定も無いときは choice が無く、落とした元は返す", () => {
    const assignments: FeatureAssignments = { typo: { provider: "ollama", model: "m" } };
    expect(
      decideFeatureAI("typo", assignments, { provider: undefined, model: undefined }, () => false)
    ).toEqual({ choice: undefined, fellBackFrom: "ollama" });
  });

  test("既定はプロバイダとモデルの両方が無いと使わない", () => {
    expect(decideFeatureAI("chat", {}, { provider: "gemini", model: undefined }, usableAll).choice).toBeUndefined();
    expect(decideFeatureAI("chat", {}, { provider: undefined, model: "m" }, usableAll).choice).toBeUndefined();
  });

  test("\"default\" は割当を見ない", () => {
    const assignments: FeatureAssignments = { typo: { provider: "ollama", model: "m" } };
    expect(decideFeatureAI("default", assignments, DEFAULT, usableAll)).toEqual({ choice: DEFAULT });
  });

  test("既定のプロバイダが使えるかは見ない（拡張機能の動きのまま）", () => {
    expect(decideFeatureAI("typo", {}, DEFAULT, () => false)).toEqual({ choice: DEFAULT });
  });
});

describe("withAssignment・withoutAssignment", () => {
  test("その機能だけを当て・外し、元の割当は変えない", () => {
    const original: FeatureAssignments = { chat: { provider: "claude", model: "c" } };
    const added = withAssignment(original, "typo", "ollama", "o");
    expect(added).toEqual({ chat: { provider: "claude", model: "c" }, typo: { provider: "ollama", model: "o" } });
    expect(original).toEqual({ chat: { provider: "claude", model: "c" } });
    const removed = withoutAssignment(added, "chat");
    expect(removed).toEqual({ typo: { provider: "ollama", model: "o" } });
    expect(added.chat).toBeDefined();
  });
});

describe("割り当てられる機能の一覧", () => {
  test("並び順と表示名が同じ機能を持ち、重なりが無い", () => {
    expect(new Set(ASSIGNABLE_FEATURES).size).toBe(ASSIGNABLE_FEATURES.length);
    expect([...ASSIGNABLE_FEATURES].sort()).toEqual(Object.keys(ASSIGNABLE_FEATURE_LABELS).sort());
  });

  test("共通設計書 4.2 の機能の数と一覧がコードと揃っている", () => {
    const doc = readFileSync("docs/共通設計書.md", "utf8");
    const section = doc.slice(doc.indexOf("### 4.2 機能別の AI の割り当て"), doc.indexOf("### 4.3"));
    expect(section, "機能の数").toContain(`割り当てられるのは${ASSIGNABLE_FEATURES.length}の機能である`);
    for (const feature of ASSIGNABLE_FEATURES) {
      expect(section, `一覧に ${feature} がある`).toContain(`${feature}（`);
    }
  });

  test("vscode と ai/ を引き込まない（モバイル版から読めるように）", () => {
    const source = readFileSync("src/core/featureAssignment.ts", "utf8");
    expect(source).not.toMatch(/from\s+"vscode"/);
    expect(source).not.toMatch(/from\s+"\.\.\/ai\//);
  });
});
