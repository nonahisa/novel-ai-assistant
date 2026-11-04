import { describe, expect, test } from "vitest";
import {
  declinedRenameKey,
  decideRenameDrift,
  describeRenameDriftQuestion,
  findRenameDriftCandidates,
  isEpisodeBodyRelPath,
  ledgerMovesForRenames,
  withoutDeclined,
} from "../../../src/core/episodeRenameDrift";

/**
 * 製品の外で変わった話の名前を、パスで話を指す台帳へどう付け替えるか
 * （設計書6.68.2。作者の決定 2026-11-04）。判定だけを試す。
 */

describe("話の本文でありうる場所か", () => {
  test("本文フォルダーの .txt/.md は本文", () => {
    expect(isEpisodeBodyRelPath("本文/003.txt", "設定")).toBe(true);
    expect(isEpisodeBodyRelPath("本文/第一章/003.md", "設定")).toBe(true);
    // 本文フォルダーの無い作品（根に話を置いた形）
    expect(isEpisodeBodyRelPath("003.txt", "設定")).toBe(true);
  });

  test("単話プロット（設定フォルダーの中）は本文ではない", () => {
    // 製品は単話プロットの名前を WorkspaceEdit で変えるので onDidRenameFiles に来る
    expect(isEpisodeBodyRelPath("設定/episode-plots/003.md", "設定")).toBe(false);
  });

  test("作業場所・退避・git の中、本文でない拡張子、作品の外は本文ではない", () => {
    expect(isEpisodeBodyRelPath(".aiwriter/memo.md", "設定")).toBe(false);
    expect(isEpisodeBodyRelPath("本文/.novelai-recovery/003.txt", "設定")).toBe(false);
    expect(isEpisodeBodyRelPath(".git/x.txt", "設定")).toBe(false);
    expect(isEpisodeBodyRelPath("本文/表紙.png", "設定")).toBe(false);
    expect(isEpisodeBodyRelPath("../別の作品/003.txt", "設定")).toBe(false);
  });

  test("設定フォルダーを作品の根と同じにした作品では、設定フォルダーで外さない", () => {
    expect(isEpisodeBodyRelPath("003.txt", ".")).toBe(true);
    expect(isEpisodeBodyRelPath("003.txt", "")).toBe(true);
  });
});

describe("エクスプローラーでの改名から付け替え表を作る", () => {
  const ledger = ["本文/第一章/001.txt", "本文/第一章/002.txt", "本文/第二章/003.txt"];

  test("話のファイルの改名は、そのまま1件", () => {
    const moves = ledgerMovesForRenames(
      [{ fromRel: "本文/第二章/003.txt", toRel: "本文/第二章/003_湖畔の誓い.txt" }],
      ledger,
      "設定"
    );
    expect([...moves]).toEqual([["本文/第二章/003.txt", "本文/第二章/003_湖畔の誓い.txt"]]);
  });

  test("話でないファイル（単話プロット）の改名は入れない", () => {
    const moves = ledgerMovesForRenames(
      [{ fromRel: "設定/episode-plots/003.md", toRel: "設定/episode-plots/004.md" }],
      [...ledger, "設定/episode-plots/003.md"],
      "設定"
    );
    expect(moves.size).toBe(0);
  });

  test("章フォルダーの改名は、台帳にある中の話ごとに付け替える", () => {
    const moves = ledgerMovesForRenames(
      [{ fromRel: "本文/第一章", toRel: "本文/第一章 旅立ち" }],
      ledger,
      "設定"
    );
    expect([...moves]).toEqual([
      ["本文/第一章/001.txt", "本文/第一章 旅立ち/001.txt"],
      ["本文/第一章/002.txt", "本文/第一章 旅立ち/002.txt"],
    ]);
  });

  test("名前の頭が同じだけの別のフォルダーは動かさない（「第一章」と「第一章外伝」）", () => {
    const moves = ledgerMovesForRenames(
      [{ fromRel: "本文/第一章", toRel: "本文/序章" }],
      [...ledger, "本文/第一章外伝/001.txt"],
      "設定"
    );
    expect([...moves.keys()]).not.toContain("本文/第一章外伝/001.txt");
  });

  test("話を設定フォルダーへ動かしたら付け替えない（話でなくなったものへ向けない）", () => {
    const moves = ledgerMovesForRenames(
      [{ fromRel: "本文/第二章/003.txt", toRel: "設定/003.txt" }],
      ledger,
      "設定"
    );
    expect(moves.size).toBe(0);
  });

  test("作品フォルダーそのもの（空の相対パス）は何も動かさない", () => {
    expect(ledgerMovesForRenames([{ fromRel: "", toRel: "" }], ledger, "設定").size).toBe(0);
  });
});

describe("名前の食い違いを見つける", () => {
  test("候補が1つなら、その組を訊く", () => {
    const list = findRenameDriftCandidates(
      ["本文/003.txt", "本文/001.txt"],
      ["本文/001.txt", "本文/002.txt", "本文/003_湖畔の誓い.txt"]
    );
    expect(list).toEqual([{ fromRel: "本文/003.txt", candidates: ["本文/003_湖畔の誓い.txt"] }]);
    expect(decideRenameDrift(list)).toEqual({
      pairs: [{ fromRel: "本文/003.txt", toRel: "本文/003_湖畔の誓い.txt" }],
      unresolved: [],
    });
  });

  test("話数の書き方が違っても、話数が同じなら候補（003.txt → 第3話 再会.md）", () => {
    const list = findRenameDriftCandidates(["本文/003.txt"], ["本文/第3話 再会.md"]);
    expect(list[0].candidates).toEqual(["本文/第3話 再会.md"]);
  });

  test("候補が無ければ訊かない（消えた話かもしれない）", () => {
    const list = findRenameDriftCandidates(["本文/003.txt"], ["本文/001.txt", "本文/004.txt"]);
    expect(decideRenameDrift(list)).toEqual({ pairs: [], unresolved: ["本文/003.txt"] });
  });

  test("台帳に載っている話は候補にしない（その話の記録は既にある）", () => {
    const list = findRenameDriftCandidates(
      ["本文/003.txt", "本文/003_別.txt"],
      ["本文/003_別.txt"]
    );
    expect(list).toEqual([{ fromRel: "本文/003.txt", candidates: [] }]);
  });

  test("候補が複数なら訊かない", () => {
    const list = findRenameDriftCandidates(
      ["本文/003.txt"],
      ["本文/003_案A.txt", "本文/003_案B.txt"]
    );
    expect(decideRenameDrift(list)).toEqual({ pairs: [], unresolved: ["本文/003.txt"] });
  });

  test("候補が複数でも、本文の印で1つに絞れたら訊く", () => {
    const list = findRenameDriftCandidates(
      ["本文/003.txt"],
      ["本文/003_案A.txt", "本文/003_案B.txt"]
    );
    const decided = decideRenameDrift(list, (_from, to) => to === "本文/003_案B.txt");
    expect(decided.pairs).toEqual([{ fromRel: "本文/003.txt", toRel: "本文/003_案B.txt" }]);
  });

  test("1つの新しい名前が2つの消えた話の候補になったら、どちらも訊かない", () => {
    // 合本と単話のように、同じ話数の旧名が2つ台帳に残っていた
    const list = findRenameDriftCandidates(
      ["本文/003.txt", "本文/第3話.txt"],
      ["本文/003_湖畔の誓い.txt"]
    );
    expect(decideRenameDrift(list)).toEqual({
      pairs: [],
      unresolved: ["本文/003.txt", "本文/第3話.txt"],
    });
  });

  test("同じフォルダーの候補を先に見る（章ごとに話数を振る作品）", () => {
    const list = findRenameDriftCandidates(
      ["本文/第一章/001.txt"],
      ["本文/第一章/001_旅立ち.txt", "本文/第二章/001.txt"]
    );
    expect(list[0].candidates).toEqual(["本文/第一章/001_旅立ち.txt"]);
  });

  test("章フォルダーごと名前が変わったら、ほかのフォルダーの候補を見る", () => {
    const list = findRenameDriftCandidates(["本文/第一章/001.txt"], ["本文/序章/001.txt"]);
    expect(list[0].candidates).toEqual(["本文/序章/001.txt"]);
  });

  test("話数の読めない名前・種別の違う話は候補にしない", () => {
    expect(findRenameDriftCandidates(["本文/続き.txt"], ["本文/続き2.txt"])[0].candidates).toEqual(
      []
    );
    expect(findRenameDriftCandidates(["本文/001.txt"], ["本文/幕間1.txt"])[0].candidates).toEqual(
      []
    );
  });

  test("食い違いが無ければ空", () => {
    expect(findRenameDriftCandidates(["本文/001.txt"], ["本文/001.txt"])).toEqual([]);
  });
});

describe("断った組を覚える・問いの文", () => {
  const pair = { fromRel: "本文/003.txt", toRel: "本文/003_湖畔の誓い.txt" };

  test("断った組は除き、組が変われば残す", () => {
    const declined = new Set([declinedRenameKey("work_a", pair)]);
    expect(withoutDeclined("work_a", [pair], declined)).toEqual([]);
    const other = { fromRel: "本文/003.txt", toRel: "本文/003_別の題.txt" };
    expect(withoutDeclined("work_a", [other], declined)).toEqual([other]);
    // 作品が違えば別の組
    expect(withoutDeclined("work_b", [pair], declined)).toEqual([pair]);
  });

  test("鍵に生の制御文字を置かない（区切りは \\u0000 のエスケープで書いてある）", () => {
    expect(declinedRenameKey("w", pair).split("\u0000")).toEqual([
      "w",
      "本文/003.txt",
      "本文/003_湖畔の誓い.txt",
    ]);
  });

  test("複数件でも1つの問いにまとめ、多いときは残りを数で言う", () => {
    const pairs = [1, 2, 3, 4, 5].map((n) => ({
      fromRel: `本文/00${n}.txt`,
      toRel: `本文/00${n}_題${n}.txt`,
    }));
    const text = describeRenameDriftQuestion("氷の街", pairs);
    expect(text).toContain("「氷の街」で名前が変わった話が5つあります。");
    expect(text).toContain("第1話「001.txt」→「001_題1.txt」");
    expect(text).toContain("第3話「003.txt」→「003_題3.txt」");
    expect(text).not.toContain("第4話");
    expect(text).toContain("ほか2話");
  });

  test("フォルダーごと変わったときは相対パスで見せる", () => {
    const text = describeRenameDriftQuestion("氷の街", [
      { fromRel: "本文/第一章/001.txt", toRel: "本文/序章/001.txt" },
    ]);
    expect(text).toContain("「本文/第一章/001.txt」→「本文/序章/001.txt」");
  });
});
