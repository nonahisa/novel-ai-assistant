import { describe, expect, test } from "vitest";
import {
  planSplit,
  rebuild,
  unnumberedCount,
} from "../../src/core/splitCollected";

/**
 * 合本ファイルの分割（設計書6.2.1）。
 *
 * **`parseCollectedFile` とは別に作った。** あちらは本文だけを返し、
 * 前書き・後書き・リアクションを落とす。AIへ渡すには正しいが、
 * **分割では落としてはいけない。** 元のファイルを置き換える操作なので、
 * **後書きが消えれば作者の文章が失われる。**
 *
 * **書き込む前に検算する。** 切った断片を繋ぎ直したものが元と1文字も
 * 違わないことを確かめ、合わなければ分割しない。
 */
const SEP = (n: number) =>
  `------------------------- エピソード${n}開始 -------------------------`;

function collected(eol = "\n"): string {
  return [
    "作品の紹介文。",
    "",
    SEP(1),
    "【エピソードタイトル】",
    "１話　転生",
    "",
    "【本文】",
    "気がつくと森の中だった。",
    "",
    "【後書き】",
    "お読みいただきありがとうございます。",
    "",
    SEP(2),
    "【エピソードタイトル】",
    "２話　出会い",
    "",
    "【本文】",
    "少女が立っていた。",
    "",
    "【リアクション】",
    "いいね: 19件",
  ].join(eol);
}

describe("分け方を組み立てる", () => {
  test("区切りごとに分ける", () => {
    const plan = planSplit(collected(), { extension: ".txt" })!;

    expect(plan.parts).toHaveLength(2);
    expect(plan.parts.map((p) => p.chapter)).toEqual([1, 2]);
    expect(plan.parts.map((p) => p.title)).toEqual(["転生", "出会い"]);
  });

  test("最初の区切りより前は preamble に残す", () => {
    // **作品の紹介などが入っている。捨てない**
    const plan = planSplit(collected(), { extension: ".txt" })!;

    expect(plan.preamble).toContain("作品の紹介文。");
  });

  test("区切り行が無ければ null（合本ではない）", () => {
    expect(planSplit("ただの本文。", { extension: ".txt" })).toBeNull();
  });
});

describe("**後書きを落とさない**", () => {
  test("後書きが本文と一緒に残る", () => {
    // **ここが `parseCollectedFile` との違い。**
    // あちらは本文だけを返すので、そのまま分割すると後書きが消える
    const plan = planSplit(collected(), { extension: ".txt" })!;

    expect(plan.parts[0].text).toContain("お読みいただきありがとうございます。");
  });

  test("リアクションも残す", () => {
    // 作者が書いたものではないが、**消すかどうかは作者が決めること**
    const plan = planSplit(collected(), { extension: ".txt" })!;

    expect(plan.parts[1].text).toContain("いいね: 19件");
  });

  test("区切り行も残す", () => {
    // **分けたあとで元へ戻せるようにする**
    const plan = planSplit(collected(), { extension: ".txt" })!;

    expect(plan.parts[0].text.startsWith("---")).toBe(true);
  });
});

describe("検算：繋ぎ直すと元に戻る", () => {
  test("LFの原稿", () => {
    const text = collected("\n");
    const plan = planSplit(text, { extension: ".txt" })!;

    expect(plan.lossless).toBe(true);
    expect(rebuild(plan.preamble, plan.parts, "\n")).toBe(text);
  });

  test("CRLFの原稿でも、改行を変えない", () => {
    // **投稿サイトのダウンロードはCRLFのことが多い**
    const text = collected("\r\n");
    const plan = planSplit(text, { extension: ".txt" })!;

    expect(plan.lossless).toBe(true);
    expect(rebuild(plan.preamble, plan.parts, "\r\n")).toBe(text);
  });

  test("紹介文が無くても戻る", () => {
    const text = [SEP(1), "【本文】", "本文。"].join("\n");
    const plan = planSplit(text, { extension: ".txt" })!;

    expect(plan.lossless).toBe(true);
    expect(rebuild(plan.preamble, plan.parts, "\n")).toBe(text);
  });

  test("本文に区切りに似た行があっても壊れない", () => {
    // 「-----」だけの行は区切りではない
    const text = [
      SEP(1),
      "【本文】",
      "-------------------------",
      "場面が変わる。",
    ].join("\n");
    const plan = planSplit(text, { extension: ".txt" })!;

    expect(plan.parts).toHaveLength(1);
    expect(plan.lossless).toBe(true);
  });
});

describe("ファイル名", () => {
  test("話数を4桁で揃える", () => {
    const plan = planSplit(collected(), { extension: ".txt" })!;

    expect(plan.parts[0].fileName).toBe("episode_0001_転生.txt");
  });

  test("拡張子は元に合わせる", () => {
    const plan = planSplit(collected(), { extension: ".md" })!;

    expect(plan.parts[0].fileName.endsWith(".md")).toBe(true);
  });

  test("桁数と頭の文字を変えられる", () => {
    const plan = planSplit(collected(), {
      extension: ".txt",
      digits: 2,
      prefix: "ep",
    })!;

    expect(plan.parts[0].fileName).toBe("ep01_転生.txt");
  });

  test("既にある名前は避ける", () => {
    // **既にある原稿を上書きしない**
    const plan = planSplit(collected(), {
      extension: ".txt",
      existing: ["episode_0001_転生.txt"],
    })!;

    expect(plan.parts[0].fileName).toBe("episode_0001_転生_2.txt");
  });

  test("同じ題が2回出ても、ぶつからない", () => {
    const text = [
      SEP(1),
      "【エピソードタイトル】",
      "１話　旅立ち",
      "【本文】",
      "あ",
      SEP(2),
      "【エピソードタイトル】",
      "１話　旅立ち",
      "【本文】",
      "い",
    ].join("\n");
    const plan = planSplit(text, { extension: ".txt" })!;

    expect(new Set(plan.parts.map((p) => p.fileName)).size).toBe(2);
  });

  test("話数が読めなければ並び順を使う", () => {
    const text = [
      SEP(1),
      "【エピソードタイトル】",
      "プロローグ",
      "【本文】",
      "あ",
    ].join("\n");
    const plan = planSplit(text, { extension: ".txt" })!;

    expect(plan.parts[0].chapter).toBeNull();
    expect(plan.parts[0].fileName).toContain("0001");
  });
});

describe("読めなかった話数を数える", () => {
  test("作者へ伝えるために数える", () => {
    const text = [
      SEP(1),
      "【エピソードタイトル】",
      "プロローグ",
      "【本文】",
      "あ",
      SEP(2),
      "【エピソードタイトル】",
      "２話　出会い",
      "【本文】",
      "い",
    ].join("\n");

    expect(unnumberedCount(planSplit(text, { extension: ".txt" })!)).toBe(1);
  });
});
