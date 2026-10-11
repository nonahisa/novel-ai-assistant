import { describe, expect, test } from "vitest";
import { buildPhotoTranscribeHtml } from "../../../src/views/photoTranscribePanelHtml";

/**
 * 写真から原稿を起こす画面（設計書6.117）。
 *
 * 画面の中の動き（回す・切る・〓へ飛ぶ）は E2E で見る（この機械では走らせない）。
 * ここでは、画面が組み立てたまま壊れていないこと（埋め込んだ台本が読めること、
 * 写真を data: で描けること）を確かめる。
 */
const html = buildPhotoTranscribeHtml("NONCE123", "vscode-resource:");

function script(): string {
  const match = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("台本が見つかりません");
  return match[1];
}

describe("写真から原稿を起こす画面", () => {
  test("写真を data: で描ける（CSP の img-src）", () => {
    expect(html).toMatch(/img-src [^;]*data:/);
    expect(html).toContain("script-src 'nonce-NONCE123'");
  });

  test("埋め込んだ台本が、文として読める（テンプレートの書き損じが無い）", () => {
    // 動かしはしない（acquireVsCodeApi が無い）。組み立てられるかだけを見る
    expect(() => new Function(script())).not.toThrow();
  });

  test("改行は台本の中で \\n のまま（文字列の中に生の改行が入っていない）", () => {
    expect(script()).toContain('.join("\\n")');
  });

  test("操作の部品がそろっている", () => {
    for (const id of [
      "photo-add",
      "photo-pick-ai",
      "photo-run",
      "photo-cancel",
      "photo-save-new",
      "photo-insert",
    ]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  test("1行の中の繰り返しで止めたページに、向きの確認を出す（A17）", () => {
    expect(script()).toContain("message.repeatStopped");
    expect(script()).toContain("同じ字が続いたので止めました。写真の向きをお確かめください。");
  });

  test("写真の向きの印で自動で直したことを、写真の札に出す（6.117.3）", () => {
    expect(script()).toContain("item.orientation");
    expect(html).toContain('data-testid": "photo-auto-rotated"');
    expect(script()).toContain("写真の向きの印に合わせて自動で直しました");
    // 作者が直す90度ずつの回転は残す
    expect(html).toContain("photo-rotate-left");
    expect(html).toContain("photo-rotate-right");
  });

  test("挿入の印や取り消し線をAIに決めさせないことを、画面でも断る", () => {
    expect(html).toContain("AIには決めさせません");
    expect(html).toContain("〓");
  });
});
