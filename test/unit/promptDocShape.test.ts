import { describe, expect, test } from "vitest";
import * as fs from "node:fs";

/**
 * プロンプト設計書の形を守る。
 *
 * 作者の指摘（2026-08-27）：「プロンプトに経過がのっているように見えますが、
 * なぜでしょうか？」——**当たっていた。** P-04a では、改訂の経過が
 * コード柵（プロンプト本文を示す枠）の**中**に書かれており、
 * 送っていない文章が送っているように読めた。
 *
 * 実際にAIへ送る文には入っていなかったので害は無かったが、
 * **文書を読んだ人は「これが送られている」と読む。** 目で見つけるのは難しい
 * （柵は128行あり、経過はその真ん中にあった）ので、機械で止める。
 *
 * あわせて、**版が実装とずれていないか**も見る。P-18は実装が3.0なのに
 * 文書は2.0、P-21は実装が3.0なのに文書は1.0のまま止まっていた。
 */

const DOC = "docs/プロンプト設計書.md";
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const QUOTE = String.fromCharCode(34);

const lines = fs.readFileSync(DOC, "utf8").split(/\r?\n/);

/** コード柵（```）で囲まれた範囲を取り出す */
function fencedBlocks(): Array<{ start: number; body: string[] }> {
  const blocks: Array<{ start: number; body: string[] }> = [];
  let open: number | undefined;
  lines.forEach((line, index) => {
    if (!/^```/.test(line)) return;
    if (open === undefined) {
      open = index;
      return;
    }
    blocks.push({ start: open + 1, body: lines.slice(open + 1, index) });
    open = undefined;
  });
  expect(open, `${DOC}: 閉じていないコード柵がある`).toBeUndefined();
  return blocks;
}

describe("プロンプト設計書の形", () => {
  test("柵の中に見出しを入れない", () => {
    // 見出しがあるということは、そこは「送っている文」ではない
    const bad = fencedBlocks()
      .filter((block) => block.body.some((line) => /^#{2,6} /.test(line)))
      .map((block) => `${block.start}行目からの柵`);

    expect(
      bad,
      `${DOC}: プロンプト本文の枠に見出しが入っている。` +
        "改訂の経過なら「#### P-XX の経過」へ移してください"
    ).toEqual([]);
  });

  test("柵の中に日付を入れない", () => {
    // 「（2026-08-15で追加）」のような注記も、送っている文ではない
    const bad = fencedBlocks()
      .filter((block) =>
        block.body.some((line) => /20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/.test(line))
      )
      .map((block) => `${block.start}行目からの柵`);

    expect(
      bad,
      `${DOC}: プロンプト本文の枠に日付が入っている。経過は末尾へ移してください`
    ).toEqual([]);
  });

  /**
   * 文書に書いた version と、実装の定数を突き合わせる。
   *
   * **文書だけを直して定数を上げ忘れる**と、古い指示で作られた応答が
   * キャッシュから返り続ける（鍵は promptVersion|model|chunkHash）。
   */
  const IMPLEMENTED: Array<[string, string, string]> = [
    ["P-02", "src/prompts/plotReverse.ts", "PLOT_REVERSE_VERSION"],
    ["P-04a", "src/prompts/characterExtract.ts", "CHARACTER_EXTRACT_VERSION"],
    ["P-06", "src/prompts/blurb.ts", "BLURB_VERSION"],
    ["P-07", "src/prompts/synopsis.ts", "SYNOPSIS_VERSION"],
    ["P-09", "src/prompts/typoCheck.ts", "TYPO_CHECK_VERSION"],
    ["P-10", "src/prompts/proofread.ts", "PROOFREAD_VERSION"],
    ["P-11", "src/prompts/deviationCheck.ts", "DEVIATION_CHECK_VERSION"],
    ["P-12", "src/prompts/contradictionCheck.ts", "CONTRADICTION_CHECK_VERSION"],
    ["P-18", "src/prompts/settingsChat.ts", "SETTINGS_CHAT_VERSION"],
    ["P-20", "src/prompts/settingsEnrich.ts", "SETTINGS_ENRICH_VERSION"],
    ["P-21", "src/prompts/workChat.ts", "WORK_CHAT_VERSION"],
    ["P-22", "src/prompts/searchTerms.ts", "SEARCH_TERMS_VERSION"],
  ];

  test.each(IMPLEMENTED)(
    "%s の version が実装と揃っている",
    (id, file, constant) => {
      // 正規表現を使わない。バックスラッシュは道具の層で潰れることがあり、
      // 潰れても「見つからない」としか出ないので原因にたどり着けない
      const source = fs.readFileSync(file, "utf8");
      const marker = `${constant} = ${QUOTE}`;
      const head = source.indexOf(marker);
      const implemented =
        head < 0
          ? undefined
          : source.slice(
              head + marker.length,
              source.indexOf(QUOTE, head + marker.length)
            );
      expect(implemented, `${file} に ${constant} が無い`).toBeTruthy();

      const at = lines.findIndex((line) =>
        line.startsWith(`### ${id}${IDEOGRAPHIC_SPACE}`)
      );
      expect(at, `${DOC} に ${id} の節が無い`).toBeGreaterThanOrEqual(0);

      const next = lines.findIndex(
        (line, index) => index > at && line.startsWith("### ")
      );
      const section = lines.slice(at, next < 0 ? undefined : next);
      const versionLine = section.find((line) =>
        line.startsWith("**version**：")
      );
      expect(
        versionLine,
        `${DOC} の ${id} に「**version**：」の行が無い`
      ).toBeTruthy();
      expect(
        versionLine,
        `${DOC} の ${id} の version が実装（${constant} = ${implemented}）と違う`
      ).toContain(implemented as string);
    }
  );

  test("表紙の版が package.json と揃っている", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      version: string;
    };
    const cover = lines.slice(0, 8).find((line) => line.startsWith("version "));
    expect(cover, `${DOC} の冒頭に version 行が無い`).toBeTruthy();
    expect(cover).toContain(pkg.version);
  });

  test("経過の節は「P-XX の経過」で揃える", () => {
    // 見出しの付け方がばらばらだと、読み飛ばしてよい部分が見分けられない
    const bad = lines
      .filter((line) => line.startsWith("#### "))
      .filter((line) => /経過|なぜ|version|v[0-9]/.test(line))
      .filter((line) => !line.endsWith("の経過"));

    expect(
      bad,
      `${DOC}: 経過らしい見出しが「#### P-XX の経過」の形になっていない`
    ).toEqual([]);
  });
});
