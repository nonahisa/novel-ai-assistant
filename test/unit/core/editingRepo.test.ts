import { describe, it, expect } from "vitest";
import {
  mergeProposalJsonl,
  editingFolderName,
  replacedDirectories,
} from "../../src/core/editingRepo";

/**
 * 編集用リポジトリ（設計書5.7.5）。
 *
 * **提案は消えてはならない。** 編集部の提案も、作者の承認・却下も、
 * 混ぜたあとに1件でも落ちたら、その判断はどこにも残らない。
 */

const proposal = (id: string) =>
  JSON.stringify({ kind: "proposal", id, file: "本文/001.md", target: "誤字" });
const decision = (id: string, decision: string) =>
  JSON.stringify({ kind: "decision", id, decision, decidedAt: "2026-08-21" });

describe("mergeProposalJsonl", () => {
  it("相手にしか無い行を後ろへ足す", () => {
    const target = `${proposal("a")}\n`;
    const source = `${proposal("b")}\n`;
    const merged = mergeProposalJsonl(target, source);
    expect(merged.added).toBe(1);
    expect(merged.text.trim().split("\n")).toEqual([proposal("a"), proposal("b")]);
  });

  it("既にある行を二重に足さない", () => {
    const both = `${proposal("a")}\n`;
    const merged = mergeProposalJsonl(both, both);
    expect(merged.added).toBe(0);
    expect(merged.text).toBe(`${proposal("a")}\n`);
  });

  it("鍵の順が違っても同じ行と見なす", () => {
    // 書き出す側で順がばらつく。並べ直して比べないと二重に積み上がる
    const target = '{"kind":"proposal","id":"a","file":"本文/001.md"}\n';
    const source = '{"file":"本文/001.md","id":"a","kind":"proposal"}\n';
    expect(mergeProposalJsonl(target, source).added).toBe(0);
  });

  it("作者の承認・却下も混ざる", () => {
    // 見送ったことが編集部へ伝わらないと、同じ提案が何度も上がってくる
    const target = `${proposal("a")}\n`;
    const source = `${proposal("a")}\n${decision("a", "rejected")}\n`;
    const merged = mergeProposalJsonl(target, source);
    expect(merged.added).toBe(1);
    expect(merged.text).toContain("rejected");
  });

  it("競合マーカーの行を落とす", () => {
    const target = `<<<<<<< HEAD\n${proposal("a")}\n=======\n${proposal("b")}\n>>>>>>> theirs\n`;
    const merged = mergeProposalJsonl(target, "");
    expect(merged.text.trim().split("\n")).toEqual([proposal("a"), proposal("b")]);
    expect(merged.text).not.toContain("<<<");
  });

  it("読めない行も残す", () => {
    // 壊れた行を落とすと、直せる見込みまで消える
    const merged = mergeProposalJsonl("こわれた行\n", `${proposal("a")}\n`);
    expect(merged.text).toContain("こわれた行");
    expect(merged.added).toBe(1);
  });

  it("もともと二重になっていた行を1つに畳む", () => {
    const merged = mergeProposalJsonl(`${proposal("a")}\n${proposal("a")}\n`, "");
    expect(merged.text).toBe(`${proposal("a")}\n`);
  });

  it("空どうしなら空を返す", () => {
    expect(mergeProposalJsonl("", "")).toEqual({ text: "", added: 0 });
  });

  it("末尾は必ず改行で終わる", () => {
    // 改行が無いと、次に足した行が前の行へ繋がってしまう
    const merged = mergeProposalJsonl(proposal("a"), proposal("b"));
    expect(merged.text.endsWith("\n")).toBe(true);
  });

  it("どちらから混ぜても中身は同じになる", () => {
    const a = `${proposal("a")}\n${decision("a", "accepted")}\n`;
    const b = `${proposal("b")}\n`;
    const forward = mergeProposalJsonl(a, b).text.trim().split("\n").sort();
    const backward = mergeProposalJsonl(b, a).text.trim().split("\n").sort();
    expect(forward).toEqual(backward);
  });
});

describe("editingFolderName", () => {
  it("作品名から作る", () => {
    expect(editingFolderName("いじめられっ子")).toBe("いじめられっ子-編集用");
  });

  it("フォルダー名に使えない文字を置き換える", () => {
    expect(editingFolderName("初恋/王女:ツンデレ")).toBe(
      "初恋_王女_ツンデレ-編集用"
    );
  });

  it("名前が空でも作れる", () => {
    expect(editingFolderName("   ")).toBe("作品-編集用");
  });
});

describe("replacedDirectories", () => {
  it("本文と設定を返す", () => {
    expect(replacedDirectories("本文", "設定")).toEqual(["本文", "設定"]);
  });

  it("同じ名前なら1つにまとめる", () => {
    // 同じフォルダーを2回消しにいくと、2回目が失敗する
    expect(replacedDirectories("原稿", "原稿")).toEqual(["原稿"]);
  });
});
