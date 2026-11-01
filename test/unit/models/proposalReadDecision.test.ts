import { describe, expect, test } from "vitest";
import {
  describeDecisionCounts,
  resolveProposals,
  summarizeDecisions,
  type ProposalLine,
} from "../../../src/models/proposal";
import { parseProposalLines } from "../../../src/core/proposalStore";

/**
 * 意見だけの提案に作者が［読んだ］を押したときの記録（設計書5.6.1.1。
 * 作者の決定 2026-11-01）。
 *
 * 0.118.0 では「採った」（accepted）として残していたので、編集部の側で
 * **意見が「採用」に数えられた。** 「読んだ」を別の状態にして、採用・見送り・
 * 読まれたを分けて数えることを確かめる。0.118.0 で残った古い記録も読めること。
 */

function proposal(id: string, suggestion: string): ProposalLine {
  return {
    kind: "proposal",
    id,
    time: "2026-11-01T10:00:00.000Z",
    proposer: "編集部",
    file: "本文/001.txt",
    line: 1,
    original: "彼は走つた。",
    target: "走つた",
    suggestion,
    reason: "気づいたこと",
    category: "編集部の直し",
  };
}

function decision(
  proposalId: string,
  status: string,
  note = ""
): ProposalLine {
  return {
    kind: "decision",
    proposalId,
    time: "2026-11-01T11:00:00.000Z",
    decidedBy: "作者",
    status,
    note,
  } as ProposalLine;
}

describe("「読んだ」の記録", () => {
  test("台帳の「読んだ」の行は読めて、提案は「読んだ」になる（未決に戻らない）", () => {
    const text = [proposal("p1", ""), decision("p1", "read", "意見を読んだ")]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const lines = parseProposalLines(text);
    expect(lines).toHaveLength(2);
    const [view] = resolveProposals(lines);
    expect(view.status).toBe("read");
  });

  test("知らない状態の行は、今までどおり捨てる", () => {
    const text = [proposal("p1", ""), decision("p1", "maybe")]
      .map((line) => JSON.stringify(line))
      .join("\n");
    expect(parseProposalLines(text)).toHaveLength(1);
  });
});

describe("採否の数え（採用・見送り・読まれた）", () => {
  test("意見を読んだものは、採用に数えない", () => {
    const views = resolveProposals([
      proposal("a", "走った"),
      decision("a", "accepted"),
      proposal("b", "駆けた"),
      decision("b", "rejected"),
      proposal("c", ""),
      decision("c", "read", "意見を読んだ"),
      proposal("d", "歩いた"),
    ]);
    expect(summarizeDecisions(views)).toEqual({
      accepted: 1,
      rejected: 1,
      read: 1,
      pending: 1,
    });
  });

  test("0.118.0 の古い記録（意見だけの提案に「採った」）は、読まれたに数える", () => {
    const views = resolveProposals([
      proposal("c", ""),
      decision("c", "accepted", "意見を読んだ"),
    ]);
    expect(summarizeDecisions(views)).toEqual({
      accepted: 0,
      rejected: 0,
      read: 1,
      pending: 0,
    });
  });

  test("知らせの形は「採用 N・見送り N・読まれた N」", () => {
    expect(
      describeDecisionCounts({ accepted: 2, rejected: 1, read: 3, pending: 0 })
    ).toBe("採用 2・見送り 1・読まれた 3");
  });
});
