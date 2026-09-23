import { describe, expect, it } from "vitest";
import {
  buildCollectedTextFromAlphapolis,
  parseAlphapolisBackup,
} from "../../../src/core/alphapolisBackup";
import { parseCollectedFile } from "../../../src/core/collectedFile";

/**
 * アルファポリスのバックアップ（.txt 直）の読み取り（設計書6.99）。
 *
 * **実物は使わない。** 作者の手元のバックアップを試験が読むと、
 * 手元にしか無いファイルに試験がぶら下がる（`workZip.test.ts` と同じ流儀）。
 * ここに書いてある形は、実物（190件の見出し・152件の文字参照・
 * 中身まで同じ重複2件）から**形だけ**を写したものである。
 */

/** 実物と同じ形——作品情報の見出しは1つも無く、いきなり章題から始まる */
const BACKUP = [
  "第一章『死の谷』",
  "１話　転生",
  "",
  "　化学の先生が、無駄話をしていた。",
  "",
  "２話　てこの原理と救助",
  "",
  "　棒を渡して、支点を作る&#x2014;&#x2014;それだけで持ち上がる。",
  "",
  "第二章『王都招聘と婚約』",
  "３話　特別監査官",
  "",
  "　辺境の村に、王都から使いが来た。",
  "",
].join("\r\n");

describe("アルファポリスのバックアップを読む", () => {
  it("作品情報の見出しが無くても、章と話で区切って読める", () => {
    const parsed = parseAlphapolisBackup(BACKUP);

    expect(parsed).not.toBeNull();
    expect(parsed?.episodes.map((episode) => episode.number)).toEqual([1, 2, 3]);
    expect(parsed?.episodes.map((episode) => episode.title)).toEqual([
      "転生",
      "てこの原理と救助",
      "特別監査官",
    ]);
  });

  it("章題を拾って、その章に属する話へ付ける", () => {
    const parsed = parseAlphapolisBackup(BACKUP);

    expect(parsed?.episodes.map((episode) => episode.part)).toEqual([
      "第一章『死の谷』",
      "第一章『死の谷』",
      "第二章『王都招聘と婚約』",
    ]);
    expect(parsed?.chapters.map((chapter) => chapter.title)).toEqual([
      "第一章『死の谷』",
      "第二章『王都招聘と婚約』",
    ]);
  });

  it("HTMLの文字参照をほどく（実物に152件あった）", () => {
    const parsed = parseAlphapolisBackup(BACKUP);

    expect(parsed?.episodes[1].body).toContain("支点を作る——それだけで");
    // **1つも残さない。** 残ると `&#x2014;` がそのまま原稿になる
    expect(
      parsed?.episodes.some((episode) => /&#?[0-9A-Za-z]+;/.test(episode.body))
    ).toBe(false);
  });

  it("文字参照は本文だけでなく、章題と話の題もほどく", () => {
    const parsed = parseAlphapolisBackup(
      [
        "第一章『死の谷&#x2049;』",
        "１話　転生&#x2014;&#x2014;はじまり",
        "",
        "　本文。",
        "",
        "２話　再会",
        "",
        "　本文。",
        "",
      ].join("\n")
    );

    expect(parsed?.chapters[0].title).toBe("第一章『死の谷⁉』");
    expect(parsed?.episodes[0].title).toBe("転生——はじまり");
  });

  it("&amp; は2度ほどかない（&amp;#x2014; が — にならない）", () => {
    const parsed = parseAlphapolisBackup(
      [
        "１話　転生",
        "",
        "　A&amp;#x2014;B と A&amp;B。",
        "",
        "２話　再会",
        "",
        "　本文。",
        "",
      ].join("\n")
    );

    expect(parsed?.episodes[0].body).toBe("　A&#x2014;B と A&B。");
  });

  describe("アルファポリスのものでなければ読まない（決め打ちしない）", () => {
    it("作品情報の見出し（【タイトル】）があれば見送る", () => {
      expect(
        parseAlphapolisBackup(
          ["【タイトル】", "星を継ぐ者たち", "", "１話　転生", "", "　本文。"].join(
            "\n"
          )
        )
      ).toBeNull();
    });

    it("なろうの合本の区切り行があれば見送る", () => {
      expect(
        parseAlphapolisBackup(
          [
            "------- エピソード1開始 -------",
            "【エピソードタイトル】",
            "１話　転生",
            "【本文】",
            "　本文。",
          ].join("\n")
        )
      ).toBeNull();
    });

    it("話の見出しが1つしか無ければ見送る（ただの原稿かもしれない）", () => {
      expect(
        parseAlphapolisBackup(["１話　転生", "", "　本文。", ""].join("\n"))
      ).toBeNull();
    });

    it("いきなり本文から始まるものは見送る（見出しで始まっていない）", () => {
      expect(
        parseAlphapolisBackup(
          [
            "　夜が更けていく。",
            "",
            "１話　転生",
            "",
            "　本文。",
            "",
            "２話　再会",
            "",
            "　本文。",
          ].join("\n")
        )
      ).toBeNull();
    });
  });

  describe("既存の合本の形へ載せ替える", () => {
    it("製品の `parseCollectedFile` がそのまま読める形になる", () => {
      const parsed = parseAlphapolisBackup(BACKUP);
      const text = buildCollectedTextFromAlphapolis(parsed!);
      const episodes = parseCollectedFile(text);

      expect(episodes?.map((episode) => episode.chapter)).toEqual([1, 2, 3]);
      expect(episodes?.map((episode) => episode.title)).toEqual([
        "転生",
        "てこの原理と救助",
        "特別監査官",
      ]);
      // 【第N章】は章の変わり目にだけ置く（なろうの合本と同じ置き方なので、
      // 章の続きの話は `part` が null になる。`collectedFile.test.ts` と同じ）
      expect(episodes?.map((episode) => episode.part)).toEqual([
        "第一章『死の谷』",
        null,
        "第二章『王都招聘と婚約』",
      ]);
      expect(episodes?.[0].body).toBe("　化学の先生が、無駄話をしていた。");
    });
  });

  describe("同じ話が2回入っている（実物の178話・179話）", () => {
    const WITH_DUPLICATE = [
      "１話　転生",
      "",
      "　本文いち。",
      "",
      "２話　再会",
      "",
      "　本文に。",
      "",
      "２話　再会",
      "",
      "　本文に。",
      "",
    ].join("\n");

    it("中身まで同じなら、片方だけ残して落としたことを覚えておく", () => {
      const parsed = parseAlphapolisBackup(WITH_DUPLICATE);

      expect(parsed?.episodes.map((episode) => episode.number)).toEqual([1, 2]);
      expect(parsed?.dropped).toEqual(["２話　再会"]);
    });

    it("中身が違うなら、どちらも落とさない（黙って捨てない）", () => {
      const parsed = parseAlphapolisBackup(
        [
          "１話　転生",
          "",
          "　本文いち。",
          "",
          "２話　再会",
          "",
          "　本文に。",
          "",
          "２話　再会",
          "",
          "　書き直した本文に。",
          "",
        ].join("\n")
      );

      expect(parsed?.episodes.map((episode) => episode.number)).toEqual([
        1, 2, 2,
      ]);
      expect(parsed?.dropped).toEqual([]);
    });

    it("行末の空白と波ダッシュの違いだけなら「同じ中身」と読む", () => {
      const parsed = parseAlphapolisBackup(
        [
          "１話　転生",
          "",
          "　本文いち。",
          "",
          "２話　再会",
          // 全角チルダ（U+FF5E）版
          "",
          "　その知識、\uff5e学校で\uff5e。",
          "",
          "２話　再会",
          // 波ダッシュ（U+301C）版＋行末の空白。Shift_JIS を通すと入れ替わる組
          "",
          "　その知識、\u301c学校で\u301c。 ",
          "",
        ].join("\n")
      );

      expect(parsed?.episodes.map((episode) => episode.number)).toEqual([1, 2]);
      expect(parsed?.dropped).toEqual(["２話　再会"]);
    });
  });
});
