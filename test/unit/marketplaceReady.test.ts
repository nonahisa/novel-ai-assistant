import { describe, expect, test } from "vitest";
import { readFileSync, statSync } from "node:fs";

/**
 * Marketplace へ出せる形になっているか（設計書8.4）。
 *
 * **`vsce publish` は、足りないものがあるとその場で止まる。** 気づくのが
 * 配布の直前になると、締切のある作業の途中で手が止まる。ここで先に見る。
 *
 * **publisher だけは決められない。** Marketplace で先に作る必要があり、
 * 世界で1つしか取れない名前なので、作者が決めるまで置き換えない。
 */
const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as Record<
  string,
  unknown
>;

describe("Marketplace の必須項目", () => {
  test("`private` が付いていない", () => {
    // npm 向けの印だが、**vsce も publish を拒む**
    expect(pkg.private).toBeUndefined();
  });

  test("アイコンはPNGを指している", () => {
    // **Marketplace はSVGを受け付けない。** アクティビティバーの
    // アイコン（SVG）とは別に要る
    expect(pkg.icon).toBe("media/icon.png");
  });

  test("アイコンが128px以上ある", () => {
    // 下限は128×128。`scripts/buildIcon.mjs` が作る
    const png = readFileSync("media/icon.png");
    expect(png.subarray(1, 4).toString("ascii"), "PNGではない").toBe("PNG");

    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBeGreaterThanOrEqual(128);
    expect(height).toBeGreaterThanOrEqual(128);
    expect(width, "正方形にする").toBe(height);
  });

  test("アイコンが大きすぎない", () => {
    // 一覧の読み込みを重くしない
    expect(statSync("media/icon.png").size).toBeLessThan(200 * 1024);
  });

  test.each([
    "name",
    "displayName",
    "description",
    "version",
    "publisher",
    "license",
    "repository",
    "engines",
    "categories",
  ])("`%s` がある", (key) => {
    expect(pkg[key]).toBeDefined();
  });

  test("リポジトリのURLが書かれている", () => {
    // **無いと vsce が止まる。** READMEの相対リンク（LICENSE など）を
    // どこへ向けるか決められないため
    expect((pkg.repository as { url?: string }).url).toMatch(
      /^https:\/\/github\.com\/.+\.git$/
    );
  });

  test("無料であることを書く", () => {
    // 書かないと一覧に「不明」と出る
    expect(pkg.pricing).toBe("Free");
  });
});

describe("配布前に気づきたいこと", () => {
  // publisher が仮のままかは、ここでは見ない。
  // **決めるまで `npm run check` が赤になってしまう。**
  // Marketplace へ出すときだけ効くよう `npm run publish:marketplace`
  // （`scripts/publishMarketplace.mjs`）で見る

  test("説明が長すぎない", () => {
    // 一覧のカードで途中から切れる
    expect(String(pkg.description).length).toBeLessThanOrEqual(400);
  });
});
