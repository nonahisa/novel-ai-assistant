import { describe, expect, test } from "vitest";
import {
  findEmphasisSpans,
  removeEmphasisText,
} from "../../../src/core/ruby";

/**
 * 傍点の付け外し（作者の裁定、2026-10-03。設計書6.34.2）。
 *
 * 傍点の付いた所を選んで［傍点］（Ctrl+Alt+K）を押すと外れる。
 * **選んだ範囲に1字でも傍点があれば、その傍点を外す**——付けるか外すかで
 * 迷う一部だけの選択は、外す側へ倒す（外しても字は1つも消えない。付ける側へ
 * 倒すと記法が入れ子になり、原稿が壊れる）。
 */

describe("選んだ範囲の傍点を見つける", () => {
  test("傍点の記法をまるごと選ぶと、その傍点が当たる", () => {
    const text = "あの{{とき}}は";
    const spans = findEmphasisSpans(text, 2, 8, "curly");
    expect(spans).toEqual([{ start: 2, end: 8, base: "とき" }]);
  });

  test("傍点の一部だけを選んでも、その傍点が当たる（記法の端まで広げる）", () => {
    const text = "あの{{とき}}は";
    // 「と」だけ（記法の内側）
    const spans = findEmphasisSpans(text, 4, 5, "curly");
    expect(spans).toEqual([{ start: 2, end: 8, base: "とき" }]);
  });

  test("傍点と平文にまたがる選択でも、傍点に1字でも掛かれば当たる", () => {
    const text = "あの{{とき}}は";
    const spans = findEmphasisSpans(text, 0, 5, "curly");
    expect(spans).toEqual([{ start: 2, end: 8, base: "とき" }]);
  });

  test("2つの傍点にまたがれば、両方が当たる", () => {
    const text = "{{あ}}と{{い}}";
    const spans = findEmphasisSpans(text, 0, text.length, "curly");
    expect(spans.map((span) => span.base)).toEqual(["あ", "い"]);
  });

  test("傍点の手前・後ろで接しているだけの選択は当たらない（付ける側）", () => {
    const text = "あの{{とき}}は";
    expect(findEmphasisSpans(text, 0, 2, "curly")).toEqual([]);
    expect(findEmphasisSpans(text, 8, 9, "curly")).toEqual([]);
  });

  test("カーソルだけなら、記法の内側と両端を当たりとする", () => {
    const text = "あの{{とき}}は";
    expect(findEmphasisSpans(text, 5, 5, "curly")).toHaveLength(1);
    expect(findEmphasisSpans(text, 8, 8, "curly")).toHaveLength(1);
    expect(findEmphasisSpans(text, 1, 1, "curly")).toEqual([]);
  });

  test("ルビは傍点として拾わない", () => {
    const text = "{漢字|かんじ}";
    expect(findEmphasisSpans(text, 0, text.length, "curly")).toEqual([]);
  });

  test(".txt（投稿サイトの記法）では《《強調》》を拾う", () => {
    const text = "あの《《とき》》は";
    expect(findEmphasisSpans(text, 4, 5, "site")).toEqual([
      { start: 2, end: 8, base: "とき" },
    ]);
  });

  test("記法を混ぜない：.md の中の《《》》、.txt の中の {{}} は傍点として扱わない", () => {
    expect(findEmphasisSpans("《《とき》》", 0, 6, "curly")).toEqual([]);
    expect(findEmphasisSpans("{{とき}}", 0, 6, "site")).toEqual([]);
  });
});

describe("傍点を外した文字列", () => {
  test("記法だけが消えて、字は残る", () => {
    const text = "あの{{とき}}は{{いま}}";
    const spans = findEmphasisSpans(text, 0, text.length, "curly");
    expect(removeEmphasisText(text, spans)).toBe("あのときはいま");
  });
});
