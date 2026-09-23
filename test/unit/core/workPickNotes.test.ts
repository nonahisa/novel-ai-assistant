import { describe, expect, test } from "vitest";
import {
  divergenceNote,
  imeDictionaryNote,
  pendingProposalNote,
  pushWaitingNote,
  sortByPickOrder,
} from "../../src/core/workPickNotes";

/**
 * 作品を選ぶ場面の補足（実機確認リスト F-15）。
 *
 * QuickPick が実際に開くことは実機に残るが、**そこに何と書くか・
 * どの作品が上に来るか**はここで確かめる。件数の印は全作品の合計なので、
 * この補足が「どの作品に溜まっているか」を知る唯一の手掛かりになる。
 */

describe("提案を確認", () => {
  test("未処理があれば件数、無ければ「未処理なし」（実機確認リスト F-15 の代わり）", () => {
    expect(pendingProposalNote(3)).toEqual({
      note: "未処理の提案 3件",
      order: 3,
    });
    expect(pendingProposalNote(0)).toEqual({ note: "未処理なし", order: 0 });
  });
});

describe("IME辞書を書き出す", () => {
  test("設定資料のほうが新しければ、そう言って上へ出す（実機確認リスト F-15 の代わり）", () => {
    expect(imeDictionaryNote({ stale: true, exported: true })).toEqual({
      note: "設定資料が辞書より新しい",
      order: 1,
    });
  });

  /** 一度も書き出していない作品を「古い」と言わない（催促にしない） */
  test("まだ書き出していない作品は、その旨だけを言う（実機確認リスト F-15 の代わり）", () => {
    expect(imeDictionaryNote({ stale: false, exported: false })).toEqual({
      note: "まだ書き出していない",
      order: 0,
    });
    expect(imeDictionaryNote({ stale: false, exported: true })).toEqual({
      note: "書き出し済み",
      order: 0,
    });
  });
});

describe("GitHubへ送る", () => {
  test("その作品ぶんの送信待ちを主に出す（実機確認リスト F-15 の代わり）", () => {
    expect(pushWaitingNote({ ahead: 2, aheadHere: 2 })).toEqual({
      note: "送信待ち 2件",
      order: 2,
    });
  });

  /** 書庫では、置き場ぜんぶの数と作品ぶんの数が食い違う */
  test("置き場ぜんぶの数が違うときは、両方書く（実機確認リスト F-15 の代わり）", () => {
    expect(pushWaitingNote({ ahead: 7, aheadHere: 2 })).toEqual({
      note: "送信待ち 2件（置き場ぜんぶでは 7件）",
      order: 2,
    });
  });

  /** 送信は置き場が単位。作品ぶんが0でも送信そのものは動く */
  test("作品ぶんが0でも、「ありません」で終わらせない（実機確認リスト F-15 の代わり）", () => {
    expect(pushWaitingNote({ ahead: 5, aheadHere: 0 })).toEqual({
      note: "この作品ぶんはありません（置き場ぜんぶでは送信待ち 5件）",
      order: 0,
    });
    expect(pushWaitingNote({ ahead: 0, aheadHere: 0 })).toEqual({
      note: "送信するものはありません",
      order: 0,
    });
  });
});

describe("分かれた分を合わせる", () => {
  test("分かれている作品には、送信待ちと受け取りの数を出す（実機確認リスト F-15 の代わり）", () => {
    expect(divergenceNote({ ahead: 3, behind: 2 })).toEqual({
      note: "分かれています（送信待ち 3件・受け取り 2件）",
      order: 1,
    });
  });

  test("分かれていなければ、そう言って下へ回す（実機確認リスト F-15 の代わり）", () => {
    expect(divergenceNote({ ahead: 3, behind: 0 })).toEqual({
      note: "分かれていません",
      order: 0,
    });
    expect(divergenceNote({ ahead: 0, behind: 4 })).toEqual({
      note: "分かれていません",
      order: 0,
    });
  });

  test("分かれている作品が上に来る（実機確認リスト F-15 の代わり）", () => {
    const rows = [
      { title: "分かれていない作品", ...divergenceNote({ ahead: 0, behind: 0 }) },
      { title: "分かれた作品", ...divergenceNote({ ahead: 1, behind: 1 }) },
    ];
    expect(sortByPickOrder(rows).map((row) => row.title)).toEqual([
      "分かれた作品",
      "分かれていない作品",
    ]);
  });

  test("元の並びは壊さない（実機確認リスト F-15 の代わり）", () => {
    const rows = [{ order: 0 }, { order: 5 }];
    sortByPickOrder(rows);
    expect(rows.map((row) => row.order)).toEqual([0, 5]);
  });
});
