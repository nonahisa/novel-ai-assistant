import { describe, expect, test } from "vitest";
import {
  locateAppliedSuggestion,
  type AppliedSuggestion,
} from "../../src/core/proposalUndo";

/**
 * 適用した直しを「戻す」ときの位置決め（設計書6.8.12）。
 *
 * **実機で見つかった不具合**（2026-09-06）：戻す側は
 * `lineText.indexOf(item.suggestion)` で行内の最初の一致を書き換えていた。
 * 修正案がありふれた語だと、**指摘より前にある関係のない箇所**を
 * 書き換えてしまう。原稿を壊す種類の不具合である。
 *
 * ここで確かめるのは、適用後の文脈（原文の `target` を `suggestion` に
 * 置き換えた文字列）で位置を決めること。
 */

function item(overrides: Partial<AppliedSuggestion> = {}): AppliedSuggestion {
  return {
    original: "彼は走つた。",
    target: "走つた",
    suggestion: "走った",
    ...overrides,
  };
}

describe("戻す位置は、適用後の文脈で決める", () => {
  test("単純な1件は、その位置を返す", () => {
    // 「彼は走った。」の「走った」は3文字目から
    expect(locateAppliedSuggestion("　彼は走った。", item())).toEqual({
      kind: "found",
      at: 3,
    });
  });

  test("同じ行の前に修正案と同じ語があっても、指摘の箇所を返す", () => {
    // **これが実機で壊れていた形。** 前にある「走った」を書き換えていた
    const line = "　彼女が走った。彼は走った。";

    expect(locateAppliedSuggestion(line, item())).toEqual({
      kind: "found",
      at: line.indexOf("彼は走った") + 2,
    });
  });

  test("適用後の文脈が行に無ければ、戻せない", () => {
    // 作者がそのあと手で書き直した行。機械が判断してよい話ではない
    expect(
      locateAppliedSuggestion("　彼は駆け出した。", item())
    ).toEqual({ kind: "missing" });
  });

  test("適用後の文脈が2つあり、適用時の列があれば、その位置を返す", () => {
    // 掛け合いの繰り返しなど、同じ文が2度出てくる行は実際にある
    const line = "　彼は走った。彼は走った。";
    const second = line.lastIndexOf("彼は走った") + 2;

    expect(
      locateAppliedSuggestion(line, item({ appliedAt: second }))
    ).toEqual({ kind: "found", at: second });
  });

  test("適用後の文脈が2つあり、適用時の列が無ければ、戻せない", () => {
    // **どちらを戻すか決められないなら、触らない**（古い項目の扱い）
    expect(
      locateAppliedSuggestion("　彼は走った。彼は走った。", item())
    ).toEqual({ kind: "ambiguous" });
  });

  test("適用時の列が当たらなくても、1つに決まるなら戻せる", () => {
    // 行の前のほうを作者が書き足すと、列はずれる。
    // それでも文脈が1つしか無いなら、戻す先は決まる
    const line = "　その夜、彼は走った。";

    expect(
      locateAppliedSuggestion(line, item({ appliedAt: 3 }))
    ).toEqual({ kind: "found", at: line.indexOf("走った") });
  });

  test("original が target を含まなければ、位置を特定しない", () => {
    // 適用側と同じ扱い（`applyIssue` も -1 なら中止する）
    expect(
      locateAppliedSuggestion("　彼は走った。", item({ target: "跳んだ" }))
    ).toEqual({ kind: "broken" });
  });

  test("適用後の文脈が空になるなら、手を出さない", () => {
    // 空文字はどの行にも「在る」ことになってしまう
    expect(
      locateAppliedSuggestion("　彼は走った。", {
        original: "走つた",
        target: "走つた",
        suggestion: "",
      })
    ).toEqual({ kind: "broken" });
  });

  test("削除の直し（修正案が空）でも、文脈で位置が決まる", () => {
    // 「彼は、、走った」→「彼は、走った」のような重複の削除
    const line = "　彼は、、走った。";

    expect(
      locateAppliedSuggestion("　彼は、走った。", {
        original: "彼は、、走った",
        target: "、",
        suggestion: "",
      })
    ).toEqual({ kind: "found", at: 3 });
    // 適用前の行（まだ「、、」のまま）には、適用後の文脈は無い
    expect(
      locateAppliedSuggestion(line, {
        original: "彼は、、走った",
        target: "、",
        suggestion: "",
      })
    ).toEqual({ kind: "missing" });
  });
});
