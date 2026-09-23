import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isMeasureTarget } from "../../../src/features/measureContext";

/**
 * 大きいモデルの案内（A3④）を、**当たりがモデルの大きさで変わる3機能**の
 * 確認へつないであるか。
 *
 * 決め方そのものは `largerModelAdvice.test.ts` が見る。ここで見るのは配線
 * ——それぞれを走らせるには画面の部品を大量に偽る必要があるので、書き方で
 * 押さえる（`confirmShowsWorkTitle.test.ts` と同じ流儀）。
 */

const FEATURES = join(__dirname, "..", "..", "..", "src", "features");

const WIRED = [
  { file: "checkContradictions.ts", feature: "contradiction", self: "checkContradictions" },
  { file: "checkTypos.ts", feature: "typo", self: "checkTypos" },
  { file: "checkProofread.ts", feature: "proofread", self: "checkProofread" },
] as const;

describe("3機能の確認に、大きいモデルの案内をつないである", () => {
  test.each(WIRED)("$file", ({ file, feature, self }) => {
    const source = readFileSync(join(FEATURES, file), "utf8");
    const call = source.indexOf("findLargerModelOffer({");
    expect(call, `${file} に案内が無い`).toBeGreaterThan(0);
    const args = source.slice(call, source.indexOf("});", call));
    expect(args).toContain(`feature: "${feature}"`);

    // **まとめ実行では案内しない**（確認を出さないので、ボタンを押す人がいない）
    const suite = source.lastIndexOf("options.suiteConfirmed", call);
    expect(suite).toBeGreaterThan(0);
    expect(source.slice(suite, call)).toMatch(/\}\s*else\s*\{/);

    // 割当を変えたら、最初からやり直す（分け方も資料の量も変わる）
    expect(source).toMatch(
      new RegExp(`=== "rerun"\\s*\\?\\s*${self}\\(work, registry, options\\)`)
    );
    // 案内は確認と同じ窓に出す
    expect(source).toMatch(/choices: offer\?\.choices/);
  });
});

describe("名指しで測る（「〈モデル〉の速さを測る」）", () => {
  test("プロバイダとモデルがそろっているときだけ名指しとみなす", () => {
    expect(isMeasureTarget({ providerId: "ollama", model: "gemma4:26b" })).toBe(true);
    expect(isMeasureTarget({ providerId: "ollama" })).toBe(false);
    expect(isMeasureTarget({ providerId: "", model: "x" })).toBe(false);
    expect(isMeasureTarget("typo")).toBe(false);
    expect(isMeasureTarget(undefined)).toBe(false);
  });

  test("コマンドは名指しを受けて、割当ではなくそのモデルを測る", () => {
    const extension = readFileSync(
      join(__dirname, "..", "..", "..", "src", "extension.ts"),
      "utf8"
    );
    expect(extension).toMatch(
      /registerCommand\("novelai\.measureContext", async \(feature\?: unknown, target\?: unknown\)/
    );
    expect(extension).toMatch(/isMeasureTarget\(target\) \? target : undefined/);
  });
});
