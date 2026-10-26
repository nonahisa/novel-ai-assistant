import { describe, expect, test } from "vitest";
import {
  CIRCLES_FIGURE_ALT,
  circlesFigureMarkdown,
  circlesFigureSvg,
} from "../../../src/core/targetSheetCirclesFigure";

/**
 * 3つの輪の図（設計書6.108.6。作者の依頼 2026-10-26）。
 *
 * 作者が会話で見た図を、シートの「3つの輪」の節に置く。見張るのは
 * **絵として出る形か**（VS Code のプレビューと、作者が使う新しい
 * Markdown 編集画面の両方の決まりに合うか）と、**作者が見た中身のままか**。
 */

/** Markdown の画像の行から data URI を取り出して、SVG の文字列へ戻す */
function decodeFigure(markdown: string): string {
  const match = /^!\[([^\]]*)\]\((data:[^)\s]+)\)$/.exec(markdown);
  expect(match, "画像の1行になっていません").not.toBeNull();
  const uri = match![2];
  const comma = uri.indexOf(",");
  return decodeURIComponent(uri.slice(comma + 1));
}

describe("3つの輪の図", () => {
  test("Markdown の画像1行で、改行を含まない（素のテキストで節を崩さない）", () => {
    const line = circlesFigureMarkdown();
    expect(line.startsWith(`![${CIRCLES_FIGURE_ALT}](`)).toBe(true);
    expect(line).not.toMatch(/[\r\n]/);
  });

  test("VS Code のプレビューが通す形（data:image/…; の後ろにセミコロン）", () => {
    // プレビューの検査は /^data:image\/.*?;/ で、`data:image/svg+xml,` のように
    // セミコロンの無い形は画像にならず文字のまま出る（1.141.0 の dist で確認）
    const line = circlesFigureMarkdown();
    expect(line).toMatch(/\]\(data:image\/svg\+xml;charset=utf-8,/);
  });

  test("Markdown の行先として壊れる字（空白・丸括弧・山括弧・#・%の生）を含まない", () => {
    const uri = /\((data:[^)]*)\)$/.exec(circlesFigureMarkdown())![1];
    expect(uri).not.toMatch(/[\s()<>"#\\]/);
    // % は %XX の形でしか出てこない
    expect(uri.replace(/%[0-9A-F]{2}/g, "")).not.toContain("%");
  });

  test("戻した SVG は元の SVG と同じ", () => {
    expect(decodeFigure(circlesFigureMarkdown())).toBe(circlesFigureSvg());
  });

  test("作者が見た図の文字がそろっている", () => {
    const svg = circlesFigureSvg();
    for (const text of [
      "すでに書けたもの",
      "実績・本文の実像",
      "書きたいもの",
      "読者としてのあなた",
      "読者が読みたいもの",
      "狙った読者・届いた反応",
      "狙い目",
      "3つが重なる所",
    ]) {
      expect(svg).toContain(`>${text}<`);
    }
  });

  test("円は3つ、色は3つとも別で、半透明で重なる", () => {
    const svg = circlesFigureSvg();
    const circles = [...svg.matchAll(/<circle [^>]*>/g)].map((m) => m[0]);
    expect(circles).toHaveLength(3);
    const fills = circles.map((c) => /fill='([^']+)'/.exec(c)![1]);
    expect(new Set(fills).size).toBe(3);
    for (const circle of circles) {
      const opacity = Number(/fill-opacity='([^']+)'/.exec(circle)![1]);
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThan(1);
    }
  });

  test("明るい・暗いテーマのどちらでも読めるよう、図が自分の地を持つ", () => {
    // 画像の中には VS Code の色の変数が届かない。地を敷かないと、
    // 暗いテーマで濃い字が背景に沈む
    const svg = circlesFigureSvg();
    expect(svg).toMatch(/<rect [^>]*fill='#[0-9a-f]{6}'/);
    expect(svg).not.toContain("var(--vscode");
  });

  test("図の中に説明の一文を置かない（作者「下の一文は不要です」）", () => {
    // 文字は見出し語と小さな添え書きだけ。句点で終わる文が無い
    expect(circlesFigureSvg()).not.toMatch(/。/);
  });

  test("毎回同じ図（材料で変えない）", () => {
    expect(circlesFigureMarkdown()).toBe(circlesFigureMarkdown());
  });
});
