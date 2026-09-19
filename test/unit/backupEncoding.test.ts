import { describe, expect, it } from "vitest";
import {
  checkBackupEncoding,
  describeBackupEncoding,
} from "../../src/core/backupEncoding";

/**
 * 取り込みの文字コードの助言（作者の指示、2026-09-19。設計書6.99）。
 *
 * **言うのは Shift_JIS のときだけ。** UTF-8 なら言うことが無い。
 * 文面は「危ないかもしれない」に留める——半角の `?` は、作者が自分で
 * 書いていることもある（実物の UTF-8 版にも2個あった）。
 */

describe("文字コードの点検", () => {
  it("Shift_JIS のファイルがあれば、半角 ? を数える", () => {
    expect(
      checkBackupEncoding([
        { encoding: "shift_jis", text: "なぜ? どうして?" },
        { encoding: "utf8", text: "これは数えない?" },
      ])
    ).toEqual({ shiftJis: true, questionMarks: 2 });
  });

  it("全角の ？ は数えない（Shift_JIS にある文字なので化けない）", () => {
    expect(
      checkBackupEncoding([{ encoding: "shift_jis", text: "なぜ？ どうして？" }])
    ).toEqual({ shiftJis: true, questionMarks: 0 });
  });

  it("UTF-8 だけなら、何も無し", () => {
    expect(
      checkBackupEncoding([
        { encoding: "utf8", text: "なぜ?" },
        { encoding: "utf8-bom", text: "どうして?" },
      ])
    ).toEqual({ shiftJis: false, questionMarks: 0 });
  });
});

describe("助言の文面", () => {
  it("UTF-8 のときは1行も出さない", () => {
    expect(
      describeBackupEncoding({ shiftJis: false, questionMarks: 3 }, "before")
    ).toEqual([]);
    expect(
      describeBackupEncoding({ shiftJis: false, questionMarks: 3 }, "after")
    ).toEqual([]);
  });

  it("取り込む前は、書き出し直して来られることまで言う", () => {
    const lines = describeBackupEncoding(
      { shiftJis: true, questionMarks: 9 },
      "before"
    ).join("\n");

    expect(lines).toContain("Shift_JIS");
    expect(lines).toContain("UTF-8");
    expect(lines).toContain("半角の ? が9個");
    // **取りやめて書き出し直せる**ことを、取り込む前にだけ言う
    expect(lines).toContain("取りやめ");
  });

  it("半角 ? が1つも無ければ、件数の行は出さない", () => {
    const lines = describeBackupEncoding(
      { shiftJis: true, questionMarks: 0 },
      "before"
    ).join("\n");

    expect(lines).toContain("Shift_JIS");
    // 1行目の「半角の ? に置き換わって…」は残る。**件数の行だけ**が出ない
    expect(lines).not.toContain("本文に半角の ?");
  });

  it("「化けている」と断定しない（作者が自分で書いた ? かもしれない）", () => {
    const lines = describeBackupEncoding(
      { shiftJis: true, questionMarks: 9 },
      "before"
    ).join("\n");

    expect(lines).not.toContain("化けています");
    expect(lines).not.toContain("失われました");
  });

  it("取り込んだあとは、取りやめの案内をしない（もう取り込んである）", () => {
    const lines = describeBackupEncoding(
      { shiftJis: true, questionMarks: 9 },
      "after"
    ).join("\n");

    expect(lines).toContain("Shift_JIS");
    expect(lines).not.toContain("取りやめ");
  });
});
