import { describe, expect, it } from "vitest";
import {
  foldTextForComparison,
  isSameBodyText,
} from "../../src/core/bodyCompare";

/**
 * 本文どうしを比べる前の、文字の揃え（設計書6.100の下ごしらえ）。
 *
 * **実データで測った**：同じ作品のなろう版とアルファポリス版を突き合わせると、
 * そのままでは87話しか一致せず、**文字を揃えると105話が一致した**。
 * 原因は `～`（全角チルダ U+FF5E）と `〜`（波ダッシュ U+301C）の食い違いで、
 * **Shift_JIS を通すと入れ替わる**古典的な落とし穴である。
 *
 * **揃えるのは CP932 で食い違う組だけ。** 全角半角や送り仮名まで畳むと、
 * 「作者が直した」ことまで「同じ」と言ってしまう。
 */

describe("比べる前に文字を揃える", () => {
  it("波ダッシュと全角チルダを同じものとして扱う", () => {
    expect(isSameBodyText("その知識、〜学校で", "その知識、～学校で")).toBe(
      true
    );
  });

  it("負符号と全角ハイフンマイナスを同じものとして扱う", () => {
    expect(isSameBodyText("気温は−５度", "気温は－５度")).toBe(true);
  });

  it("双柱と平行を同じものとして扱う", () => {
    expect(isSameBodyText("‖そして‖", "∥そして∥")).toBe(true);
  });

  it("emダッシュと横線を同じものとして扱う", () => {
    expect(isSameBodyText("沈黙——そして", "沈黙――そして")).toBe(
      true
    );
  });

  it("セント・ポンド・否定記号の全角と半角を同じものとして扱う", () => {
    expect(isSameBodyText("¢£¬", "￠￡￢")).toBe(true);
  });

  it("改行コードの違いは無視する（Shift_JIS 版は CRLF）", () => {
    expect(isSameBodyText("一行目\r\n二行目", "一行目\n二行目")).toBe(true);
  });

  it("行末の空白と、前後の空行は無視する", () => {
    expect(isSameBodyText("\n\n本文。  \n\n", "本文。")).toBe(true);
  });

  it("途中の空行は残す（段落の切れ目は本文の一部）", () => {
    expect(isSameBodyText("一行目\n\n二行目", "一行目\n二行目")).toBe(false);
  });

  it("全角と半角の数字は畳まない（作者が直したかもしれない）", () => {
    expect(isSameBodyText("１５分", "15分")).toBe(false);
  });

  it("中身が違えば違うと言う", () => {
    expect(isSameBodyText("本文。", "書き直した本文。")).toBe(false);
  });

  it("揃えた結果は、どちらの版からも同じ文字列になる", () => {
    expect(foldTextForComparison("〜−‖—")).toBe(
      foldTextForComparison("～－∥―")
    );
  });
});
