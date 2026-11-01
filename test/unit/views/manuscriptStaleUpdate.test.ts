import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 打った字より古い本文で、画面を描き直さない（設計書6.25.9。2026-11-02）。
 *
 * 画面の自動テスト（manuscriptTermsEol）の揺れを調べて見つかった。面の中の記録は
 * 毎回「+1ms 打った字が出る → +4ms 本体から打つ前の本文が届いて描き直す →
 * +21ms 打った字の便が入る → +139〜206ms 新しい本文が届いて字が戻る」。
 * 面を押して前へ出したときの送り直し（onDidChangeViewState）が、便を当てる前の
 * 本文を読んで送っていた。
 *
 * 本体は本文に「何番の便まで裁き終えていたか」（handledSeq）を添え、画面は
 * 返事の来ていない便がそれより新しければ、その本文を使わない。
 * 本体の側（番号を本文と同じ瞬間に読む・当て終えてから進める）は
 * `features/manuscriptStaleUpdateHost.test.ts`、本物の画面での順は
 * E2E の `manuscriptTypedNotReverted.test.ts` が見る。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const source = html.slice(
  html.indexOf("/* staleUpdate:start */"),
  html.indexOf("/* staleUpdate:end */")
);
const api = new Function(source + "\nreturn { updateBehindTyping };")() as {
  updateBehindTyping(
    handledSeq: unknown,
    sentSeq: number,
    waiting: boolean,
    firstTaken: boolean
  ): boolean;
};

describe("打った字より古い本文かを見分ける", () => {
  it("返事の来ていない便が、本体の裁き終えた番号より新しければ古い本文", () => {
    // 便3を送った直後に、便2までしか知らない本文が届いた（s9.txt の +4ms）
    expect(api.updateBehindTyping(2, 3, true, true)).toBe(true);
  });

  it("便を裁き終えたあとの本文は取り込む（+206ms の新しい本文）", () => {
    expect(api.updateBehindTyping(3, 3, true, true)).toBe(false);
    expect(api.updateBehindTyping(4, 3, true, true)).toBe(false);
  });

  it("返事が全部来ていれば取り込む（ホストが起動し直して番号が0に戻っても固まらない）", () => {
    expect(api.updateBehindTyping(0, 12, false, true)).toBe(false);
  });

  it("番号の添えられていない本文（古い本体）は今までどおり取り込む", () => {
    expect(api.updateBehindTyping(undefined, 3, true, true)).toBe(false);
  });

  it("最初の1便は必ず取り込む（開いた直後の見た目・控えが添えてある）", () => {
    expect(api.updateBehindTyping(0, 1, true, false)).toBe(false);
  });
});

describe("受け口での使い方", () => {
  const code = html.slice(html.indexOf("<script"));
  const listener = code.slice(code.indexOf('window.addEventListener("message", function (event) {'));
  const gateAt = listener.indexOf("updateBehindTyping(message.handledSeq, editSeq, unconfirmed !== null, updateTaken)");

  it("本文の便を受けたら、最初に門を通す", () => {
    expect(gateAt).toBeGreaterThan(-1);
  });

  it("門は、current と元（setEditBase）と描き直し（takeIncoming）より前にある", () => {
    const branch = listener.indexOf('if (message.type === "update") {');
    expect(branch).toBeGreaterThan(gateAt);
    const after = listener.slice(branch);
    // 古い本文で current を書き換えると、焦点が外れたときの送りが偽の記録を残す
    expect(gateAt).toBeLessThan(branch + after.indexOf("current = message.text"));
    expect(gateAt).toBeLessThan(branch + after.indexOf("takeIncoming(message.text"));
    expect(gateAt).toBeLessThan(branch + after.indexOf("composeTakeIncoming(message.text"));
  });

  it("捨てたら、そこで戻る（取り込みへ進まない）", () => {
    const gate = listener.slice(gateAt, listener.indexOf('if (message.type === "update") {'));
    expect(gate).toContain("return;");
    // 記録に本文を入れない（字数と番号だけ）
    expect(gate).not.toContain("message.text +");
  });

  it("取り込んだら、最初の1便を取り込んだ印を立てる", () => {
    const branch = listener.slice(listener.indexOf('if (message.type === "update") {'));
    expect(branch.slice(0, 200)).toContain("updateTaken = true;");
  });
});
