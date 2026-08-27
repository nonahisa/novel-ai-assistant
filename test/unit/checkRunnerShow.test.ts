import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `createQuickPick` は `show()` を呼ぶまで画面に出ない。
 *
 * 0.22.13 で「実機確認を回す」の節一覧を `createQuickPick` へ書き換えたとき
 * `show()` が抜け、**押しても何も起きない**状態で出荷した（画面が出ないまま
 * Promise を待ち続ける。エラーも出ないので、実機で押すまで誰も気づけない）。
 *
 * QuickPickの配線そのものは単体テストで動かせないため、ソースの数を見張る。
 * 「作った数だけ show している」ことしか確かめられない粗い網だが、
 * 今回の抜け（2つ作って1つしか show していない）はこれで止まる。
 */
describe("createQuickPick の show 忘れ", () => {
  test("作った選択画面の数だけ、show を呼んでいる", () => {
    const source = readFileSync(
      join(__dirname, "../../src/dev/checkRunner.ts"),
      "utf-8"
    );
    const created = source.match(/createQuickPick/g)?.length ?? 0;
    const shown = source.match(/\.show\(\)/g)?.length ?? 0;

    expect(created).toBeGreaterThan(0);
    expect(shown).toBeGreaterThanOrEqual(created);
  });
});
