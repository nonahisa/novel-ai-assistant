import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 飛んだ段落をまるごと見える所へ転がす量の決め方（作者の実機確認、2026-10-04。
 * 設計書6.25.11）。
 *
 * 縦書きで［本文へ］から飛ぶと、段落が2列以上に折り返しているとき2列目が
 * 左端で半分隠れた。段落の頭（カーソル）だけを見える所へ入れていたためである。
 *
 * 画面のJSは webview のテンプレート文字列の中にしか無いので、配られるHTMLから
 * 印（`revealScroll:start` 〜 `revealScroll:end`）の間を切り出して動かす
 * ——試しているのは、そのまま画面へ渡る本物である。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const source = html.slice(
  html.indexOf("/* revealScroll:start */"),
  html.indexOf("/* revealScroll:end */")
);

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const api = new Function(source + "\nreturn { revealScrollDelta, REVEAL_SLACK };")() as {
  revealScrollDelta(
    box: Box,
    whole: Box,
    head: Box,
    isVertical: boolean
  ): { left: number; top: number };
  REVEAL_SLACK: number;
};

/** 画面の入れ物（幅800・高さ600） */
const box: Box = { left: 0, right: 800, top: 0, bottom: 600 };

/** 箱を delta だけ転がしたあとの位置（スクロールを増やすと中身は逆へ動く） */
function moved(rect: Box, delta: { left: number; top: number }): Box {
  return {
    left: rect.left - delta.left,
    right: rect.right - delta.left,
    top: rect.top - delta.top,
    bottom: rect.bottom - delta.top,
  };
}

function inside(rect: Box): boolean {
  return (
    rect.left >= box.left &&
    rect.right <= box.right &&
    rect.top >= box.top &&
    rect.bottom <= box.bottom
  );
}

describe("切り出し", () => {
  it("印で挟んであり、切り出せる", () => {
    expect(source).toContain("function revealScrollDelta(");
    expect(api.REVEAL_SLACK).toBeGreaterThan(0);
  });
});

describe("縦書き（列は右から左へ並ぶ）", () => {
  it("頭の列は見えていても、2列目が左端で切れていれば、段落ごと右へ寄せる", () => {
    // 作者の画面の形：頭の列（30〜60）は見えているが、2列目（-10〜30）が左端で半分隠れる
    const whole: Box = { left: -10, right: 60, top: 0, bottom: 580 };
    const head: Box = { left: 30, right: 60, top: 0, bottom: 580 };
    const delta = api.revealScrollDelta(box, whole, head, true);
    expect(delta.left).toBeLessThan(0);
    const after = moved(whole, delta);
    expect(inside(after)).toBe(true);
    // 端ぎりぎりではなく、少し内側へ入れる
    expect(after.left).toBe(api.REVEAL_SLACK);
    expect(delta.top).toBe(0);
  });

  it("段落がまるごと見えていれば動かさない", () => {
    const whole: Box = { left: 300, right: 400, top: 0, bottom: 580 };
    const head: Box = { left: 360, right: 400, top: 0, bottom: 580 };
    expect(api.revealScrollDelta(box, whole, head, true)).toEqual({ left: 0, top: 0 });
  });

  it("段落が右の外にあれば、はみ出したぶん（＋少し）だけ左へ寄せる", () => {
    const whole: Box = { left: 700, right: 900, top: 0, bottom: 580 };
    const head: Box = { left: 860, right: 900, top: 0, bottom: 580 };
    const delta = api.revealScrollDelta(box, whole, head, true);
    const after = moved(whole, delta);
    expect(inside(after)).toBe(true);
    expect(after.right).toBe(box.right - api.REVEAL_SLACK);
  });

  it("段落が画面より長いときは、頭の列を右端の側へ置く（頭が見えることを優先）", () => {
    const whole: Box = { left: -2000, right: 60, top: 0, bottom: 580 };
    const head: Box = { left: 30, right: 60, top: 0, bottom: 580 };
    const delta = api.revealScrollDelta(box, whole, head, true);
    const headAfter = moved(head, delta);
    expect(headAfter.right).toBe(box.right - api.REVEAL_SLACK);
    expect(inside(headAfter)).toBe(true);
  });

  it("ちょうど入る幅なら、少し内側へ入れるために反対側を外へ出さない", () => {
    const whole: Box = { left: -5, right: 785, top: 0, bottom: 580 };
    const head: Box = { left: 755, right: 785, top: 0, bottom: 580 };
    const after = moved(whole, api.revealScrollDelta(box, whole, head, true));
    expect(inside(after)).toBe(true);
  });
});

describe("横書き（行は上から下へ並ぶ）", () => {
  it("頭の行が下端にあり続きの行が下に切れていれば、段落ごと上へ寄せる", () => {
    const whole: Box = { left: 0, right: 780, top: 550, bottom: 700 };
    const head: Box = { left: 0, right: 780, top: 550, bottom: 600 };
    const delta = api.revealScrollDelta(box, whole, head, false);
    const after = moved(whole, delta);
    expect(inside(after)).toBe(true);
    expect(after.bottom).toBe(box.bottom - api.REVEAL_SLACK);
    expect(delta.left).toBe(0);
  });

  it("段落が画面より長いときは、頭の行を上端の側へ置く", () => {
    const whole: Box = { left: 0, right: 780, top: 550, bottom: 3000 };
    const head: Box = { left: 0, right: 780, top: 550, bottom: 580 };
    const headAfter = moved(head, api.revealScrollDelta(box, whole, head, false));
    expect(headAfter.top).toBe(box.top + api.REVEAL_SLACK);
  });
});

describe("飛ぶ道がみな同じ決め方を使う", () => {
  /**
   * F8／Shift+F8・パネルの行・［本文へ］・提案パネルの行は、どれも
   * 拡張機能から revealLine を送り、画面の revealLine 1つで受ける。
   * その中で、2つの面がどちらも段落の箱を測って転がすことを見る。
   */
  const reveal = html.slice(
    html.indexOf("/* revealLine:start */"),
    html.indexOf("/* revealLine:end */")
  );

  it("組んで書く面は段落をまるごと見せる道を先に試す", () => {
    expect(reveal).toContain("composeRevealParagraph(start)");
  });

  it("打つ面も、光らせた段落の箱で転がす", () => {
    const write = reveal.slice(reveal.indexOf("function revealFlashWrite("));
    expect(write.slice(0, write.indexOf("\n  }\n"))).toContain("revealScrollTo(");
  });
});
