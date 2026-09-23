import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

/**
 * **中止したのに「完了しました」と出さない**（ノートPCの実機、0.76.1、2026-09-23）。
 *
 * ## 何が起きたか
 *
 * 誤字脱字検知を中止した直後に、
 * 「誤字脱字検知を中止しました。完了済みの処理は次回再利用されます。」と
 * 「誤字脱字検知が完了しました。指摘 9件。」が**同時に**出た（9件は前から
 * 提案パネルに残っていた指摘の数）。
 *
 * ## なぜ起きたか
 *
 * `checkTypos` は中止を `cancelled: true` の結果として返す（`undefined` では
 * ない）。ところが誤字脱字の3つの入口（作品全体・1話だけ・相談パネルの
 * 「いま開いている話」）は `if (!result)` しか見ておらず、中止の結果を
 * そのまま完了の知らせ（`reportTypoCheckResult`）へ渡していた。
 * 伏線・逸脱・推敲・矛盾・表記ゆれ・単話プロットの入口は
 * `result.cancelled` を見ていたので、**誤字脱字だけが抜けていた**。
 *
 * まとめ実行（設計書6.80）では、中止したのに `CHECK_COMPLETED` を返して
 * **次の機能へ進んでしまう**ことにもなっていた。
 *
 * ## 何を固定するか
 *
 * 進捗つきで検知を走らせる入口（`withPanelProgress(`）ごとに、結果を
 * 提案パネル・知らせへ渡すより前で `.cancelled` を見ていること。
 * 型では守れない配線なので、ソースの形で止める（`generateCancellation` と
 * 同じ方式）。
 */

const EXTENSION = path.join(__dirname, "..", "..", "..", "src", "extension.ts");

/** 結果を作者へ出す呼び出し。ここより前で中止を見ていなければならない */
const REPORTERS = /showResults\(|report\w*\(|notifyRunCompletion\(|recordCheck\(/;

interface Site {
  readonly line: number;
  /** `withPanelProgress(` から最初の「結果を出す呼び出し」までの本文 */
  readonly before: string;
}

function progressSites(source: string): Site[] {
  const sites: Site[] = [];
  const needle = "await withPanelProgress(";
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    const rest = source.slice(at);
    const match = REPORTERS.exec(rest);
    // 結果を作者へ出さない入口は、完了を名乗りようがないので見なくてよい
    if (match) {
      sites.push({
        line: source.slice(0, at).split("\n").length,
        before: rest.slice(0, match.index),
      });
    }
    from = at + needle.length;
  }
  return sites;
}

describe("中止した検知は、完了を名乗らない", () => {
  const source = fs.readFileSync(EXTENSION, "utf8");
  const sites = progressSites(source);

  test("進捗つきの検知の入口が見つかる（走査そのものが空振りしていない）", () => {
    // 誤字脱字3・伏線2・逸脱・単話プロット2・推敲・矛盾・事実の矛盾
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  test("結果を知らせる前に、中止されたかを見ている", () => {
    const missing = sites
      .filter((site) => !/\.cancelled\b/.test(site.before))
      .map((site) => `src/extension.ts:${site.line}`);
    expect(missing).toEqual([]);
  });

  test("誤字脱字の入口は、中止を完了として返さない（まとめ実行が次へ進まない）", () => {
    const typoSites = sites.filter((site) => site.before.includes("checkTypos("));
    expect(typoSites.length).toBe(3);
    for (const site of typoSites) {
      expect(site.before).toMatch(/if \(!result \|\| result\.cancelled\)/);
    }
  });
});
