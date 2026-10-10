import { describe, expect, test } from "vitest";
import {
  batchVerbFromLabel,
  describeRecordUpdateBatchLog,
  describeRecordUpdateLog,
  describeUpdatesDiscardedByMoveLog,
  summarizeRecordUpdateForLog,
} from "../../../src/core/recordUpdateLog";
import { diffCharacter } from "../../../src/core/characterDiff";
import { emptyCharacter, type Character } from "../../../src/models/character";

/**
 * 設定資料の更新を反映・見送りしたときの動作の記録の1行（設計書5.6・6.32）。
 *
 * 2026-10-10、作者の作品で人物6件が提案パネルから書き換わったのに、
 * 作品のログに1行も残っていなかった。ここでは行の言い方を固定する
 * （書くかどうかは `features/applyPendingUpdates.test.ts` と
 * `features/proposalPanelRecordUpdateLog.test.ts` が見る）。
 */

function person(extra: Partial<Character> = {}): Character {
  return { ...emptyCharacter("char_001", "リンセップ・アウクト"), ...extra };
}

describe("何が変わったかの要約", () => {
  test("別名は数で、性格は書き足しとして言う", () => {
    const diff = diffCharacter(
      person({ personality: "無口" }),
      person({ aliases: ["リン", "アウクト卿", "王女の騎士"], personality: "無口。忠義に厚い" })
    );
    expect(summarizeRecordUpdateForLog(diff)).toBe("別名＋3・性格（追記）");
  });

  test("✕ で落とした葉は「入った数」に数えない", () => {
    const diff = diffCharacter(person(), person({ aliases: ["リン", "アウクト卿"] }));
    expect(summarizeRecordUpdateForLog(diff, { dropKeys: ["alias:リン"] })).toBe("別名＋1");
  });

  test("空からの追加・書き換え・消去を言い分ける", () => {
    const diff = diffCharacter(
      person({ summary: "騎士", role: "護衛" }),
      person({ summary: "近衛騎士", gender: "男性" })
    );
    expect(summarizeRecordUpdateForLog(diff)).toBe("紹介（変更）・性別（追加）・役割（削除）");
  });

  test("新しく作る案は「新規作成」とだけ言う", () => {
    const diff = diffCharacter(emptyCharacter("char_000", ""), person({ summary: "騎士" }));
    expect(summarizeRecordUpdateForLog(diff, { creation: true })).toBe("新規作成");
  });
});

describe("1件の行", () => {
  const diff = diffCharacter(
    person({ personality: "無口" }),
    person({ aliases: ["リン", "アウクト卿", "王女の騎士"], personality: "無口。忠義に厚い" })
  );

  test("適用：種類・名前・要約・押した画面が1行に入る", () => {
    expect(
      describeRecordUpdateLog({
        verdict: "applied",
        kindLabel: "人物",
        name: "リンセップ・アウクト",
        diff,
        via: "提案パネル",
      })
    ).toBe(
      "設定資料の更新を適用：人物「リンセップ・アウクト」 別名＋3・性格（追記）（提案パネル）"
    );
  });

  test("見送り：同じ形で動詞だけ変わる", () => {
    expect(
      describeRecordUpdateLog({
        verdict: "dismissed",
        kindLabel: "人物",
        name: "リンセップ・アウクト",
        diff,
        via: "確認ダイアログ",
      })
    ).toBe(
      "設定資料の更新を見送り：人物「リンセップ・アウクト」 別名＋3・性格（追記）（確認ダイアログ）"
    );
  });

  test("出どころと、✕ で落とした数を添える", () => {
    expect(
      describeRecordUpdateLog({
        verdict: "applied",
        kindLabel: "人物",
        name: "リンセップ・アウクト",
        diff,
        via: "提案パネル",
        sourceLabel: "外部AIから",
        dropKeys: ["alias:リン"],
        dropped: 1,
      })
    ).toBe(
      "設定資料の更新を適用：人物「リンセップ・アウクト」 別名＋2・性格（追記）〔外部AIから〕（✕で1件を落とした）（提案パネル）"
    );
  });
});

describe("まとめて押したときの件数の行", () => {
  test("入った数と全体を並べる", () => {
    expect(
      describeRecordUpdateBatchLog({
        category: "設定資料の更新",
        verb: batchVerbFromLabel(undefined),
        applied: 6,
        total: 6,
        via: "提案パネル",
      })
    ).toBe("設定資料の更新をまとめて適用：6/6件（提案パネル）");
  });

  test("入らなかった数と落とした数を黙らない", () => {
    expect(
      describeRecordUpdateBatchLog({
        category: "設定資料の更新",
        verb: "適用",
        applied: 4,
        total: 6,
        failed: 2,
        dropped: 3,
        via: "確認ダイアログ",
      })
    ).toBe(
      "設定資料の更新をまとめて適用：4/6件（反映できなかった 2件、✕で落とした 3件）（確認ダイアログ）"
    );
  });

  test("押しボタンの語を持つ分類（伏線の候補など）は、その語を使う", () => {
    expect(batchVerbFromLabel("登録する")).toBe("登録");
  });
});

describe("移す案の反映で古くなった更新案を片づけた行（0.102.4）", () => {
  test("人物の名前と、どこから押したかを書く", () => {
    expect(
      describeUpdatesDiscardedByMoveLog({ names: ["アジャーノ", "殿下"], via: "提案パネル" })
    ).toBe(
      "設定資料の更新を片づけ：人物「アジャーノ」「殿下」の承認待ちの更新案" +
        "（移す案の反映で古くなったため。もう一度抽出すると作り直されます）（提案パネル）"
    );
  });
});
