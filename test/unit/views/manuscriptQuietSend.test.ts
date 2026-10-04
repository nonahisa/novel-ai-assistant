import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 打鍵の知らせ無しに画面の字を送るときの記録（作者の報告、2026-10-04 23時。
 * 設計書6.25.9）。
 *
 * 「// 」が2行続く所の1行が、作者の操作なしに原稿から消えて自動保存された。
 * 画面からの記録が何も無く、どの道で送られたかを追えなかったので、焦点が
 * 外れたとき・保存を頼んだときに画面の字が原稿と違っていたら1行残す。
 * **本文は書かない**（行数と最初に違う行の番号だけ）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const source = html.slice(
  html.indexOf("/* quietSend:start */"),
  html.indexOf("/* quietSend:end */")
);
const api = new Function(source + "\nreturn { quietSendSummary };")() as {
  quietSendSummary(
    before: string,
    after: string
  ): { beforeLines: number; afterLines: number; firstLine: number } | null;
};

describe("原稿と画面の字の違いを行で言う", () => {
  it("同じなら何も言わない", () => {
    expect(api.quietSendSummary("あ\n// \n// \nい", "あ\n// \n// \nい")).toBeNull();
  });

  it("メモの行が1行減ったら、行数と最初に違う行を返す", () => {
    expect(
      api.quietSendSummary("「こ」\n\n// \n// \n　僕が", "「こ」\n\n// \n　僕が")
    ).toEqual({ beforeLines: 5, afterLines: 4, firstLine: 4 });
  });

  it("行の中の字が変わったときも、その行を指す", () => {
    expect(api.quietSendSummary("あ\nい\nう", "あ\nいx\nう")).toEqual({
      beforeLines: 3,
      afterLines: 3,
      firstLine: 2,
    });
  });
});

describe("記録する場所", () => {
  const code = html.slice(html.indexOf("<script"));

  it("焦点が外れたときの送りの前に見る（変換中は見ない）", () => {
    const flush = code.slice(code.indexOf("function flushUnsent(reason) {"));
    const body = flush.slice(0, flush.indexOf("\n  }\n"));
    expect(body).toContain("if (!composing) noteQuietSend(reason);");
    // 送るより前に記録する
    expect(body.indexOf("noteQuietSend")).toBeLessThan(body.indexOf("composeSend()"));
  });

  it("保存を頼んだときの送りの前に見る", () => {
    const ask = code.slice(code.indexOf("function askSave() {"));
    const body = ask.slice(0, ask.indexOf("\n  }\n"));
    expect(body.indexOf('noteQuietSend("保存を頼んだ")')).toBeGreaterThan(-1);
    expect(body.indexOf("noteQuietSend")).toBeLessThan(body.indexOf("composeSend("));
  });

  it("記録の文に本文を入れない（行数と行番号だけ）", () => {
    const note = code.slice(code.indexOf("function noteQuietSend(reason) {"));
    const body = note.slice(0, note.indexOf("\n  }\n"));
    expect(body).not.toContain("shown +");
    expect(body).not.toContain("current +");
  });
});
