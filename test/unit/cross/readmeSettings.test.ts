/**
 * READMEの設定一覧と、実際の設定定義がずれていないか確かめる。
 *
 * **作者はREADMEを見て設定を変える。** 載っていない設定は存在に気づけず、
 * 既定値が違えば「書いてあるとおりにしたのに動きが違う」ことになる。
 * 実際に、料金に直結する `mergeChunkChars` とGit連携の3つが載っておらず、
 * Claudeのタイムアウトは実際300秒なのに180秒と書かれていた。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = new URL("../../", import.meta.url);
const readme = readFileSync(fileURLToPath(new URL("README.md", root)), "utf8");
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("package.json", root)), "utf8")
) as {
  contributes: {
    configuration: { properties: Record<string, { default?: unknown }> };
  };
};

const properties = manifest.contributes.configuration.properties;

/** READMEの表から「設定名 → 既定値の表記」を読む */
function documentedDefaults(): Map<string, string> {
  const rows = [...readme.matchAll(/^\|\s*`(novelai\.[^`]+)`\s*\|\s*([^|]+?)\s*\|/gm)];
  return new Map(rows.map((row) => [row[1], row[2].trim()]));
}

describe("READMEの設定一覧", () => {
  test("すべての設定が載っている", () => {
    const missing = Object.keys(properties).filter(
      (key) => !readme.includes(key)
    );

    expect(missing).toEqual([]);
  });

  test("載っている既定値が実際と一致する", () => {
    const mismatched: string[] = [];

    for (const [key, shown] of documentedDefaults()) {
      const actual = properties[key]?.default;
      if (actual === undefined) {
        // 消した設定を案内し続けていないか
        mismatched.push(`${key}: package.jsonに無い`);
        continue;
      }
      // README側は `0`（自動） のように補足が付く。記号と補足を落として比べる
      const normalized = shown
        .replace(/`/g, "")
        .replace(/（.*?）/g, "")
        .replace(/"/g, "")
        .trim();
      if (normalized !== String(actual)) {
        mismatched.push(`${key}: README="${normalized}" 実際="${actual}"`);
      }
    }

    expect(mismatched).toEqual([]);
  });
});
