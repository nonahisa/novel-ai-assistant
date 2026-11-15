/**
 * 最後の行で次の行へ進むキーを押したときに改行を足す判定（`views/lastLineNewlineScript.ts`。設計書6.25）。
 *
 * 作者の依頼（2026-11-15）：「最終行で下ボタンを押した場合、改行を自動で入れて欲しい。
 * ただし空行2行でストップで」。埋め込む JavaScript を、作り物の値の上で動かして確かめる。
 * 画面で押して増えることは、画面の自動テスト（test/e2e/lastLineNewline.test.ts）が見る。
 */
import { describe, expect, it } from "vitest";
import {
  LAST_LINE_NEWLINE_KEY_HORIZONTAL,
  LAST_LINE_NEWLINE_KEY_VERTICAL,
  LAST_LINE_NEWLINE_SOURCE,
} from "../../../src/views/lastLineNewlineScript";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

interface Part {
  lastLineNewlineKey(vertical: boolean): string;
  lastLineBlankCount(text: string): number;
  lastLineNewlineAllowed(text: string, start: number, end: number): boolean;
}

const part = new Function(
  `${LAST_LINE_NEWLINE_SOURCE}
  return { lastLineNewlineKey, lastLineBlankCount, lastLineNewlineAllowed };`
)() as Part;

describe("次の行へ進むキー", () => {
  it("横書きは ↓、縦書きは ←（作者の答え 2026-11-15「縦書きは←キー」。本物の Mac でも ← が次の行へ進む）", () => {
    expect(part.lastLineNewlineKey(false)).toBe(LAST_LINE_NEWLINE_KEY_HORIZONTAL);
    expect(part.lastLineNewlineKey(true)).toBe(LAST_LINE_NEWLINE_KEY_VERTICAL);
    expect(LAST_LINE_NEWLINE_KEY_HORIZONTAL).toBe("ArrowDown");
    expect(LAST_LINE_NEWLINE_KEY_VERTICAL).toBe("ArrowLeft");
  });

  it("機械（Mac かどうか）でキーを分けない（1.0.9 の分け方は 1.0.11 でやめた）", () => {
    const html = buildManuscriptEditorHtml("n", "c");
    expect(html).toContain("lastLineNewlineKey(isVertical)");
    expect(html).not.toContain("lastLineNewlineOnMac");
  });
});

describe("末尾の空行の数", () => {
  it.each([
    ["字で終わる", "あいう", 0],
    ["末尾の改行1つ（最後の行が空）", "あいう\n", 1],
    ["末尾の改行2つ", "あいう\n\n", 2],
    ["末尾の改行3つ", "あいう\n\n\n", 3],
    ["途中の空行は数えない", "あ\n\nい", 0],
    ["空の本文は空行1行", "", 1],
  ])("%s", (_name, text, expected) => {
    expect(part.lastLineBlankCount(text)).toBe(expected);
  });
});

describe("改行を足してよいか", () => {
  it("カーソルが文書の末尾（後ろに字が無い所）にあるときは足す（空行が1行増える）", () => {
    expect(part.lastLineNewlineAllowed("あいう", 3, 3)).toBe(true);
    expect(part.lastLineNewlineAllowed("あ\nいう", 4, 4)).toBe(true);
  });

  it("最後の行の途中では足さない（行を割って字を押し出さない。作者 2026-11-15 本物の Mac で「。」が次の行へ押し出された）", () => {
    // 「あ\nいう。」の「。」の手前・「い」の後ろ
    expect(part.lastLineNewlineAllowed("あ\nいう。", 4, 4)).toBe(false);
    expect(part.lastLineNewlineAllowed("あ\nいう。", 3, 3)).toBe(false);
    expect(part.lastLineNewlineAllowed("あいう", 0, 0)).toBe(false);
  });

  it("続けて押すと、末尾の空行が2行になるまで足し、そこで止まる", () => {
    let text = "あいう";
    let added = 0;
    for (let press = 0; press < 5; press++) {
      if (!part.lastLineNewlineAllowed(text, text.length, text.length)) break;
      text += "\n";
      added++;
    }
    expect(added).toBe(2);
    expect(text).toBe("あいう\n\n");
  });

  it("末尾に改行が1つあるファイル（最後の行が空）では、あと1つだけ足せる", () => {
    expect(part.lastLineNewlineAllowed("あいう\n", 4, 4)).toBe(true);
    expect(part.lastLineNewlineAllowed("あいう\n\n", 5, 5)).toBe(false);
  });

  it("最後の行でない（カーソルより後ろに改行がある）ときは足さない", () => {
    expect(part.lastLineNewlineAllowed("あ\nい", 1, 1)).toBe(false);
    expect(part.lastLineNewlineAllowed("あいう\n", 1, 1)).toBe(false);
  });

  it("選んだ範囲があるときは足さない", () => {
    expect(part.lastLineNewlineAllowed("あいう", 1, 3)).toBe(false);
  });

  it("位置が読めないときは足さない", () => {
    expect(part.lastLineNewlineAllowed("あいう", -1, -1)).toBe(false);
    expect(part.lastLineNewlineAllowed("あいう", 9, 9)).toBe(false);
  });
});

describe("原稿エディターへの配線", () => {
  const html = buildManuscriptEditorHtml("n", "c");

  it("組んで書く面と打つ面の両方の keydown で判定を呼ぶ", () => {
    expect(html).toContain("lastLineNewlinePress(event, true)");
    expect(html).toContain("lastLineNewlinePress(event, false)");
  });

  it("改行は Enter と同じ道（execCommand）で入れる", () => {
    expect(html).toContain('document.execCommand("insertParagraph")');
    expect(html).toContain('document.execCommand("insertText", false, "\\n")');
  });

  it("変換中・Shift つき・校閲中は何もしない", () => {
    const body = html.slice(html.indexOf("function lastLineNewlinePress"));
    expect(body.slice(0, 900)).toContain("composing || event.isComposing");
    expect(body.slice(0, 900)).toContain("event.shiftKey");
    expect(body.slice(0, 900)).toContain("reviewLocked");
  });
});
