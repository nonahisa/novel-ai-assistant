import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { groupOkuriganaVariants } from "../../src/core/okuriganaVariants";

/**
 * 送り仮名ゆれを、**作者の実データ**で確かめる。
 *
 * 見たいのは1つ。**活用形を巻き込んでいないか。**
 * 単体テストは自分で選んだ例なので、実際の文章で確かめないと意味がない。
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();

/** 漢字で始まり、漢字と平仮名だけでできた連なりを拾う */
const WORD = /[一-鿿々][一-鿿々ぁ-ゟ]*/gu;

describe.skipIf(!ROOT)("実データの送り仮名ゆれ", () => {
  test("挙がった組を並べる", () => {
    const words: string[] = [];
    for (const entry of fs.readdirSync(ROOT!, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "backups") continue;
      const dir = path.join(ROOT!, entry.name);
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".txt")) continue;
        const text = fs.readFileSync(path.join(dir, name), "utf-8");
        for (const m of text.matchAll(WORD)) words.push(m[0]);
      }
    }

    const groups = groupOkuriganaVariants(words);
    const report = [
      `語 ${new Set(words).size.toLocaleString("ja-JP")}種類から ${groups.length}組`,
      "",
      ...groups.slice(0, 60).map((g) => "  " + g.join(" / ")),
    ].join("\n");
    console.log("\n" + report);
    fs.writeFileSync(
      process.env.NOVELAI_REPORT?.trim() ?? "okurigana.txt",
      report,
      "utf-8"
    );
    expect(true).toBe(true);
  });
});
