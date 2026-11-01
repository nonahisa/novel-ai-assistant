import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 画面へ送る本文に「この画面の便を何番まで裁き終えたか」を添える（設計書6.25.9。2026-11-02）。
 *
 * 面を押して前へ出したときの送り直し（onDidChangeViewState → send）が、打った字の便を
 * 当てる前の本文を読んで送り、画面が打つ前の本文で描き直していた（打った字が0.1〜0.2秒
 * 消えた）。画面の側の門は `views/manuscriptStaleUpdate.test.ts`。
 *
 * 源の形で見張る（`resolveCustomTextEditor` を代役で組むには依存が多すぎる。
 * `manuscriptSendOrder.test.ts`・`manuscriptConflictSendNow.test.ts` と同じやり方）。
 */
const source = readFileSync("src/features/manuscriptEditor.ts", "utf8");

function between(startMark: string, endMark: string, from = 0): string {
  const start = source.indexOf(startMark, from);
  const end = source.indexOf(endMark, start + startMark.length);
  expect(start, `${startMark} が見つからない（形が変わったらこのテストを直す）`).toBeGreaterThan(-1);
  expect(end, `${endMark} が見つからない`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("本文に添える番号", () => {
  test("send は、本文を読んだ直後に番号を読み、待ちを挟まずに添えて送る", () => {
    const body = between("const send = async (): Promise<void> => {", "docKey: key,");
    const readText = body.indexOf("const text = toLf(document.getText());");
    const readSeq = body.indexOf("const textHandledSeq = handledSeq;");
    const post = body.indexOf("await panel.webview.postMessage({");
    expect(readText).toBeGreaterThan(-1);
    expect(readSeq).toBeGreaterThan(readText);
    expect(post).toBeGreaterThan(readSeq);
    // 本文と番号のあいだに待ちを挟まない（挟むと、本文は古いのに番号だけ進む）
    expect(body.slice(readText, readSeq)).not.toContain("await ");
    expect(body.slice(post)).toContain("handledSeq: textHandledSeq,");
  });
});

describe("番号を進める時機", () => {
  const apply = between("const applyScreenEdit = async (item: SentEdit): Promise<ApplyOutcome> => {", "const queueEdit = createEditQueue");

  test("当てる便は、当て終えてから進める（先に進めると、番号は新しいのに本文は打つ前になる）", () => {
    const applyAt = apply.indexOf("let result = await this.applyEdit(document, decision.text);");
    expect(applyAt).toBeGreaterThan(-1);
    const firstMark = apply.indexOf("markHandled(item);", apply.indexOf('if (decision.kind === "conflict") {') + 1);
    // 当てる道で最初に出てくる markHandled は、重なった道のもの（当てる前に戻る）。
    // 当てる道の markHandled は applyEdit の後にだけある
    const afterApply = apply.indexOf("markHandled(item);", applyAt);
    expect(afterApply).toBeGreaterThan(applyAt);
    expect(firstMark).toBeLessThan(applyAt);
    const conflictBranch = apply.slice(apply.indexOf('if (decision.kind === "conflict") {'), applyAt);
    expect(conflictBranch).toContain("markHandled(item);");
  });

  test("重なって控えへ回すときは、今の本文を送る前に進める（送った本文を画面が捨てない）", () => {
    const conflictBranch = between('if (decision.kind === "conflict") {', 'return "conflict";');
    expect(conflictBranch.indexOf("markHandled(item);")).toBeGreaterThan(-1);
    expect(conflictBranch.indexOf("markHandled(item);")).toBeLessThan(conflictBranch.indexOf("sendNow();"));
  });

  test("編集部が校閲中で入れないときも、送る前に進める", () => {
    const locked = between("if (await this.lockedByEditor(document)) {", 'return "conflict";');
    expect(locked.indexOf("markHandled(item);")).toBeGreaterThan(-1);
    expect(locked.indexOf("markHandled(item);")).toBeLessThan(locked.indexOf("sendNow();"));
  });

  test("差の無い便でも、裁く前の本文を送っていたら送り直す", () => {
    expect(apply).toContain('if (result === "noop" && handledSeqSent < handledSeq) sendNow();');
  });

  test("当てる途中で投げた便も裁いたことにする（画面が本体の本文を受け取れなくならない）", () => {
    const queue = between("const queueEdit = createEditQueue<SentEdit>(", "combineSentEdits(older, newer, textFingerprint)");
    const fin = queue.indexOf("} finally {");
    expect(fin).toBeGreaterThan(-1);
    expect(queue.slice(fin)).toContain("markHandled(item);");
  });
});
