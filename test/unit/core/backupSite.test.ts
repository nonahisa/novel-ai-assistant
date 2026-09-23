import { describe, expect, it } from "vitest";
import { detectBackupSite } from "../../../src/core/backupSite";

/**
 * バックアップZIPの出どころの見分け（設計書6.99）。
 *
 * **見分けられないことのほうが多い、を前提に試す。** 決め打ちで「カクヨム」と
 * 書くと、なろうの作品の台帳へカクヨムの記録が入り、あとから分けられない。
 * 通る道（カクヨム・なろう）と、**通ってはいけない道**の両方を見る。
 */

/** 実物のカクヨムのバックアップ（2026-09-19、作者のZIPから欄だけ写した） */
const KAKUYOMU_ABOUT = [
  "【タイトル】",
  "星を継ぐ者たち",
  "",
  "【作者名】",
  "hisa",
  "",
  "【連載状態】",
  "連載中",
  "",
  "【ジャンル】",
  "異世界ファンタジー",
  "",
  "【セルフレイティング】",
  "- 残酷描写有り",
  "",
  "【イメージカラー】",
  "#828282",
  "",
].join("\n");

describe("バックアップの出どころを見分ける", () => {
  it("カクヨムにしか無い欄があれば、カクヨムと読む", () => {
    expect(
      detectBackupSite({
        zipFileName: "星を継ぐ者たち_20260919.zip",
        workInfoText: KAKUYOMU_ABOUT,
      })
    ).toBe("kakuyomu");
  });

  it("欄が括弧付きでも見分けられる（【紹介文（9行）】と同じ書き方）", () => {
    expect(
      detectBackupSite({
        zipFileName: "星を継ぐ者たち.zip",
        workInfoText: "【セルフレイティング（2件）】\n- 残酷描写有り\n",
      })
    ).toBe("kakuyomu");
  });

  it("ZIPの名前がNコードなら、なろうと読む", () => {
    expect(
      detectBackupSite({ zipFileName: "N1111IR.zip", workInfoText: null })
    ).toBe("narou");
  });

  it("作品情報に【Nコード】があれば、なろうと読む", () => {
    expect(
      detectBackupSite({
        zipFileName: "むかしの原稿.zip",
        workInfoText: "【タイトル】\n星を継ぐ者たち\n\n【Nコード】\nn1234ab\n",
      })
    ).toBe("narou");
  });

  it("手がかりが無ければ、決め打ちしない", () => {
    expect(
      detectBackupSite({
        zipFileName: "原稿まとめ.zip",
        workInfoText: "【タイトル】\n星を継ぐ者たち\n\n【あらすじ】\nむかしむかし。\n",
      })
    ).toBeNull();
  });

  it("作品情報そのものが無ければ、決め打ちしない", () => {
    expect(
      detectBackupSite({ zipFileName: "原稿まとめ.zip", workInfoText: null })
    ).toBeNull();
  });

  /*
    **両方の手がかりが出たら、どちらとも言わない。** 片方を優先すると、
    優先したほうが常に勝つ——混ざった台帳は、あとから誰の数字か分けられない。
  */
  it("両方の手がかりが出たら、どちらとも書かない", () => {
    expect(
      detectBackupSite({
        zipFileName: "N1111IR.zip",
        workInfoText: KAKUYOMU_ABOUT,
      })
    ).toBeNull();
  });

  it("アルファポリスの .txt の形が読めれば、アルファポリスと読む", () => {
    expect(
      detectBackupSite({
        zipFileName: "転生受験生の教科書チート生活 (2).txt",
        workInfoText: null,
        alphapolisHeader: true,
      })
    ).toBe("alphapolis");
  });

  it("アルファポリスの手がかりと他サイトの手がかりが揃ったら、どちらとも書かない", () => {
    expect(
      detectBackupSite({
        zipFileName: "N1111IR.zip",
        workInfoText: null,
        alphapolisHeader: true,
      })
    ).toBeNull();
    expect(
      detectBackupSite({
        zipFileName: "星を継ぐ者たち.zip",
        workInfoText: KAKUYOMU_ABOUT,
        alphapolisHeader: true,
      })
    ).toBeNull();
  });

  it("Nコードに見えるだけの題を、なろうと読み違えない", () => {
    // 「N」で始まって数字が続くだけの題（Nコードは N＋4桁＋英字2文字）
    expect(
      detectBackupSite({ zipFileName: "N700系のぞみ.zip", workInfoText: null })
    ).toBeNull();
    expect(
      detectBackupSite({ zipFileName: "N12345ab.zip", workInfoText: null })
    ).toBeNull();
  });
});
