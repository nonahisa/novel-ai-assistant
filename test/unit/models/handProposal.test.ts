import { describe, expect, test } from "vitest";
import {
  HAND_EDIT_CATEGORY,
  buildHandProposal,
  handProposalTarget,
  isOpinionOnly,
  locateProposal,
} from "../../../src/models/proposal";

/**
 * 編集部が手で書く提案の組み立て（設計書5.6.1.1。作者の指示 2026-11-01）。
 *
 * **採る側は「行の中で最初に見つかった所」を書き換える**（`locateProposal`）。
 * 同じ語が1行に2度ある行で2つ目を選んだとき、1つ目が書き換わる事故は
 * この作品で実際に起きた（0.34.3、提案パネルの「戻す」）。置く側で
 * 「選んだ所だけを指す」形にしておくことを、ここで確かめる。
 */

describe("選んだ所を、提案の original／target にする", () => {
  test("1行に1度だけの語は、その語だけで指せる", () => {
    const line = "　彼は走つた。";
    const at = line.indexOf("走つた");
    const picked = handProposalTarget(line, at, at + 3);
    expect(picked).toEqual({ ok: true, original: "走つた", target: "走つた" });
    if (!picked.ok) return;
    expect(locateProposal(line, { line: 1, ...picked })).toEqual({
      kind: "found",
      at,
    });
  });

  test("同じ語の2つ目を選ぶと、前後を含めて2つ目だけを指す", () => {
    const line = "かもしれない。でも、かもしれない。";
    const second = line.lastIndexOf("かもしれない");
    const picked = handProposalTarget(line, second, second + 6);
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.target).toBe("かもしれない");
    // 採る側の照らし方で、2つ目に当たる
    expect(locateProposal(line, { line: 1, ...picked })).toEqual({
      kind: "found",
      at: second,
    });
  });

  test("選んでいなければ、行ぜんたいを指す（メモ）", () => {
    expect(handProposalTarget("　夜が明けた。\r", 3, 3)).toEqual({
      ok: true,
      original: "　夜が明けた。",
      target: "　夜が明けた。",
    });
  });

  test("空の行・空白だけの選択は断る", () => {
    expect(handProposalTarget("　", 0, 0).ok).toBe(false);
    expect(handProposalTarget("あ　い", 1, 2).ok).toBe(false);
  });

  test("同じ字が並び、1か所に決まらないときは断る", () => {
    expect(handProposalTarget("ああああ", 2, 3).ok).toBe(false);
  });
});

describe("手書きの提案を組み立てる", () => {
  const base = {
    file: "本文/003.txt",
    line: 1,
    original: "走つた",
    target: "走つた",
    proposer: "編集部",
    time: "2026-11-01T00:00:00.000Z",
    category: HAND_EDIT_CATEGORY,
  };

  test("直した案と理由がそのまま載る", () => {
    const built = buildHandProposal({ ...base, suggestion: "走った", reason: "促音" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal).toMatchObject({
      suggestion: "走った",
      reason: "促音",
      category: "編集部の直し",
    });
    expect(isOpinionOnly(built.proposal)).toBe(false);
  });

  test("選んだ所のまま進めたら、意見だけになる", () => {
    const built = buildHandProposal({ ...base, suggestion: "走つた", reason: "ここは古風でよいか" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.suggestion).toBe("");
    expect(isOpinionOnly(built.proposal)).toBe(true);
  });

  test("直した案も意見も無いものは置かない", () => {
    expect(buildHandProposal({ ...base, suggestion: "", reason: "　" }).ok).toBe(false);
  });

  test("同じ所への別の意見は、別の番号になる（畳まれて消えない）", () => {
    const first = buildHandProposal({ ...base, suggestion: "", reason: "一つ目" });
    const second = buildHandProposal({ ...base, suggestion: "", reason: "二つ目" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.proposal.id).not.toBe(second.proposal.id);
  });
});
