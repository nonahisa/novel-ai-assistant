import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/**
 * モバイル版（novel-ai-mobile）が借りる core の部品に、`vscode` が混ざっていないか。
 *
 * モバイル版は core・models をそのまま取り込む。`vscode` を1つでも静的に読むと、
 * 取り込んだ先では読み込んだ瞬間に落ちる（`mcpReach.test.ts` と同じ理屈）。
 * 話の名前を変えたあとの台帳の付け替え（`episodeRenumber.ts`）と、読みの辞書の
 * 置き場の決まり（`readingDictionaryPlace.ts`）を、モバイル版が同じ決まりで使う（2026-11-21）
 */
const MOBILE_ENTRY_NAMES = ["episodeRenumber", "readingDictionaryPlace"];

describe("モバイル版が借りる core の部品に `vscode` が混ざっていないか", () => {
  const entries = MOBILE_ENTRY_NAMES.map((name) => path.join(SRC, "core", `${name}.ts`));

  test("起点のファイルがすべて実在する", () => {
    expect(entries.filter((file) => !fs.existsSync(file)).map(relativeName)).toEqual([]);
  });

  test("どの起点からも、静的 import で `vscode` へ届かない", () => {
    const offenders: string[] = [];
    for (const entry of entries) {
      const reach = walkStaticImports([entry]);
      for (const bare of reach.bare) {
        if (bare.spec === "vscode") offenders.push(`${chainTo(reach, bare.file)} -> vscode`);
      }
      // たどり方が壊れて自分しか見ていないと、上は素通りする
      expect(reach.files.size, `${relativeName(entry)} から先をたどれていません`).toBeGreaterThan(1);
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});
