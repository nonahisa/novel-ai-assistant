import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 設定資料の抽出・各話あらすじを**取りやめた**とき、内訳に「失敗しました」と
 * 出ていた（2026-09-26 精査 R15。実機確認リスト【残る粗さ】、設計書6.104
 * 「見分けが付かないまま残っているもの」）。
 *
 * 2つの関数の戻り値が真偽しか無く、確認で断った回も走って失敗した回も
 * 同じ `false` だった。戻り値を「済んだ／取りやめ／失敗」の3つにして、
 * コマンドの登録がそれを `CHECK_CANCELLED` と名乗るようにした。
 *
 * `activate` もAIの確認画面も単体では動かせないので、ほかの配線の見張り
 * （`guidedTourWiring.test.ts`）と同じく**書いてある形**で見る。
 */

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function read(file: string): string {
  return withoutComments(readFileSync(file, "utf8"));
}

/** `marker` のあとの、最初の `return` の値 */
function returnAfter(source: string, marker: string | RegExp): string {
  const at = typeof marker === "string" ? source.indexOf(marker) : source.search(marker);
  expect(at, `${String(marker)} が見つからない`).toBeGreaterThan(-1);
  const matched = /return\s+([^;]+);/.exec(source.slice(at));
  return matched ? matched[1].trim() : "";
}

/** コマンドの登録の中身（次の registerCommand の手前まで） */
function registrationOf(source: string, command: string): string {
  const at = source.indexOf(`"${command}",`);
  expect(at, `${command} の登録が見つからない`).toBeGreaterThan(-1);
  const next = source.indexOf("registerCommand(", at);
  return source.slice(at, next < 0 ? source.length : next);
}

describe("設定資料の抽出：取りやめを取りやめと返す", () => {
  const source = read("src/features/extractCharacters.ts");

  test("戻り値は真偽ではなく3つの印", () => {
    expect(source).toMatch(/export async function extractCharacters\([\s\S]*?\): Promise<FeatureRunResult>/);
  });

  test("確認画面で断ったら取りやめ", () => {
    expect(returnAfter(source, "if (!confirmed)")).toBe('"cancelled"');
  });

  test("競合の確認で「中止」を選んだら取りやめ", () => {
    expect(returnAfter(source, 'if (proceed !== "run")')).toBe('"cancelled"');
  });

  test("走っている途中で中止したら取りやめ", () => {
    expect(returnAfter(source, /if \(cancelled\) \{/)).toBe('"cancelled"');
  });

  test("AIが未設定・本文が無いなど、走れなかったのは失敗のまま", () => {
    expect(returnAfter(source, "if (!resolved)")).toBe('"failed"');
    expect(returnAfter(source, "if (scan.episodes.length === 0)")).toBe('"failed"');
  });
});

describe("各話あらすじ：取りやめを取りやめと返す", () => {
  const source = read("src/features/generateSynopses.ts");

  test("戻り値は真偽ではなく3つの印", () => {
    expect(source).toMatch(/export async function generateSynopses\([\s\S]*?\): Promise<FeatureRunResult>/);
  });

  test("形式が合わない確認で断ったら取りやめ", () => {
    expect(returnAfter(source, "confirmFormatFit(")).toBe('"cancelled"');
  });

  test("確認画面で断ったら取りやめ", () => {
    expect(returnAfter(source, "if (!confirmed)")).toBe('"cancelled"');
  });

  test("AIが未設定なのは失敗のまま", () => {
    expect(returnAfter(source, "if (!resolved)")).toBe('"failed"');
  });
});

describe("コマンドの登録が、取りやめを名乗る", () => {
  const source = read("src/extension.ts");

  for (const [command, variable] of [
    ["novelai.extractSettings", "extracted"],
    ["novelai.generateSynopses", "generated"],
  ] as const) {
    test(`${command}：関数が取りやめと返したら CHECK_CANCELLED`, () => {
      const body = registrationOf(source, command);
      expect(body).toMatch(
        new RegExp(`if \\(${variable} === "cancelled"\\)\\s*return CHECK_CANCELLED;`)
      );
      expect(body).toMatch(new RegExp(`if \\(${variable} === "done"\\)`));
    });
  }
});
