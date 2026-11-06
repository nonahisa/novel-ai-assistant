import { describe, expect, test } from "vitest";
import {
  aliasLooksAddressedToOriginal,
  aliasUsageTowardOriginal,
} from "../../../src/core/separateAliasUsage";

/**
 * 別名を別人に分ける前の知らせ（作者の裁定 2026-11-06「分ける前に断る」）。
 *
 * 実データ（2026-09-07）：「文佳」から「お嬢様」を分けたら中身が空のまま残った。
 * 本文の「お嬢様」はどれも文佳への呼びかけだった。**その形なら知らせ、
 * 別の人物として出ている所が1つでもあれば知らせない**ことの両方を見る。
 */

const fumika = ["文佳", "密倉文佳", "文佳ちゃん"];

describe("呼び名が元の人物に向いているか", () => {
  test("実データの形：呼びかけと、文佳と同じ所に出るものだけなら知らせる", () => {
    const text = [
      "秘書が駆け込んできた。",
      "「お嬢様、副社長からお返事が」",
      "文佳は顔を上げた。",
      "",
      "あの夜のことを思い出す。",
      "「文佳ちゃん、お嬢様なんだ」",
      "",
      "密倉文佳の過去を知る者は少ない。",
      "お嬢様は逆恨みで襲われた。",
    ].join("\n");
    const usage = aliasUsageTowardOriginal("お嬢様", fumika, [text]);
    expect(usage).toEqual({ total: 3, towardOriginal: 3 });
    expect(aliasLooksAddressedToOriginal(usage)).toBe(true);
  });

  test("元の人物と離れた所に、地の文で出る所が1つでもあれば知らせない", () => {
    const text = [
      "「お嬢様、副社長からお返事が」",
      "文佳は顔を上げた。",
      "",
      "",
      "屋敷の奥で、お嬢様は窓の外を眺めていた。",
    ].join("\n");
    const usage = aliasUsageTowardOriginal("お嬢様", fumika, [text]);
    expect(usage.total).toBe(2);
    expect(usage.towardOriginal).toBe(1);
    expect(aliasLooksAddressedToOriginal(usage)).toBe(false);
  });

  test("台詞の外で後ろに読点が来ても、呼びかけとは数えない", () => {
    const usage = aliasUsageTowardOriginal("お嬢様", fumika, ["お嬢様、つまりその家の娘は笑った。"]);
    expect(usage).toEqual({ total: 1, towardOriginal: 0 });
  });

  test("呼び名が元の名前を含んでも、それだけで同じ所とは数えない（「文佳様」と「文佳」）", () => {
    const usage = aliasUsageTowardOriginal("文佳様", ["文佳"], ["文佳様は屋敷の奥にいた。"]);
    expect(usage).toEqual({ total: 1, towardOriginal: 0 });
  });

  test("本文に出ない呼び名は知らせない（見るものが無い）", () => {
    const usage = aliasUsageTowardOriginal("お嬢様", fumika, ["文佳は笑った。"]);
    expect(usage.total).toBe(0);
    expect(aliasLooksAddressedToOriginal(usage)).toBe(false);
  });

  test("同じ行に2回出たら2回と数える。塊が分かれていても足す", () => {
    const usage = aliasUsageTowardOriginal("お嬢様", fumika, [
      "「お嬢様、お嬢様！」",
      "「お嬢様？」と文佳に訊いた。",
    ]);
    expect(usage).toEqual({ total: 3, towardOriginal: 3 });
  });
});
