import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 相談パネルが、AIの出した実行ボタン（`run`）を話題で照らしてから持つか
 * （2026-09-25 深夜の実接続の測定。照らす規則そのものは
 * `test/unit/core/chatRunRelevance.test.ts`）。
 *
 * 規則だけあっても、パネルが素の `answer.run` をボタンにしていては効かない。
 * `ask` は AI を呼ぶので単体では動かせず、**書いてあるコードの形**で見る
 * （`cross/chatRunEntry.test.ts` と同じやり方）。
 */
const source = readFileSync("src/features/workChatPanel.ts", "utf8");

/** 答えから提案を組み立てる所（`const staged = {` から `};` まで） */
function stagedBlock(): string {
  const start = source.indexOf("const staged = {");
  expect(start, "提案を組み立てる所が見つからない").toBeGreaterThan(-1);
  const end = source.indexOf("};", start);
  return source.slice(start, end);
}

describe("相談パネルの実行ボタン", () => {
  test("AIの run をそのままボタンにしない", () => {
    expect(stagedBlock()).not.toContain("stageRun(answer.run");
  });

  test("話題で照らした結果をボタンにする", () => {
    expect(stagedBlock()).toContain("stageRun(relatedRun?.kind");
    expect(source).toMatch(/relatedChatRun\(answer\.run, \[\s*question,\s*\.\.\.earlierAuthorTurns/);
  });

  test("照らす材料の直前の発言は、今回の質問を履歴へ積む前に取る", () => {
    // 積んだあとに取ると、今回の質問が「直前の発言」になり、何も足さない
    const taken = source.indexOf("const earlierAuthorTurns = this.lastAuthorTurns()");
    const pushed = source.indexOf('{ role: "author", text: question }');
    expect(taken).toBeGreaterThan(-1);
    expect(pushed).toBeGreaterThan(taken);
  });
});
