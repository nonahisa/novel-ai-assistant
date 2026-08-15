import { describe, expect, test } from "vitest";
import {
  findMergeCandidates,
  isFamilyNameForm,
  isSuffixCallOf,
} from "../../src/core/characterMerge";
import { emptyCharacter, type Character } from "../../src/models/character";

/**
 * 日本語では、同じ人物を「近所のおばあさん」と説明的に書いたり、
 * 単に「ばあさん」と呼んだりする。AIは場面ごとに違う書き方を拾うので
 * 別レコードになりやすい（実データ「いじめられっ子」で発生）。
 *
 * カタカナ語の省略（ギルマス）を見る `isAbbreviationOf` では拾えないため、
 * 「後ろに含まれる呼び方」を別の手掛かりとして足した。
 */

function character(name: string, aliases: string[] = []): Character {
  return { ...emptyCharacter(`char_${name}`, name), aliases };
}

describe("後ろに含まれる呼び方", () => {
  test("説明的な呼び方と短い呼び方を結び付ける", () => {
    expect(isSuffixCallOf("ばあさん", "近所のおばあさん")).toBe(true);
    expect(isSuffixCallOf("お母さん", "文佳のお母さん")).toBe(true);
  });

  test("丁寧の「お」の有無だけの違いも同じ呼び方とみなす", () => {
    expect(isSuffixCallOf("おばあさん", "近所のばあさん")).toBe(true);
  });

  test("2字以下の語では判定しない", () => {
    // 「先生」「たち」で結ぶと、無関係な組が大量に並んで
    // 作者が候補を読まなくなる
    expect(isSuffixCallOf("先生", "教頭先生")).toBe(false);
    expect(isSuffixCallOf("たち", "母親たち")).toBe(false);
  });

  test("長さが離れすぎた組は結ばない", () => {
    // たまたま末尾が揃っただけのことが多い
    expect(
      isSuffixCallOf("ばあさん", "村はずれに住んでいる不思議なばあさん")
    ).toBe(false);
  });

  test("末尾が重ならなければ結ばない", () => {
    expect(isSuffixCallOf("じいさん", "近所のおばあさん")).toBe(false);
    expect(isSuffixCallOf("ばあさんの家", "近所のばあさん")).toBe(false);
  });

  test("同じ長さ・同じ語では結ばない", () => {
    expect(isSuffixCallOf("ばあさん", "ばあさん")).toBe(false);
  });
});

/**
 * 日本語の名前は空白で区切られないことが多い。「密倉文佳」を分解できないため、
 * 後から「文佳」が出てくると別人として登録される（実データで発生）。
 * `isSuffixCallOf` は3字以上しか見ないので、2字の名（文佳・月夜・太志）は通れない。
 */
describe("姓名と、名だけの呼び方", () => {
  test("姓を落とした呼び方を結び付ける", () => {
    expect(isFamilyNameForm("文佳", "密倉文佳")).toBe(true);
    expect(isFamilyNameForm("太志", "三門太志")).toBe(true);
    expect(isFamilyNameForm("月夜", "春原月夜")).toBe(true);
  });

  test("姓が長すぎる組は結ばない", () => {
    // 姓は3字まで（長谷川）。それ以上は別の語がくっついているだけ
    expect(isFamilyNameForm("太志", "長谷川部太志")).toBe(false);
  });

  test("1字では判定しない", () => {
    // 「子」「郎」で結ぶと無関係な組が大量に並ぶ
    expect(isFamilyNameForm("郎", "太郎")).toBe(false);
  });

  test("ひらがな・カタカナだけの語は対象にしない", () => {
    // 「ちゃん」「さん」を姓とみなさないため。
    // カタカナ語の省略は isAbbreviationOf が見る
    expect(isFamilyNameForm("ふみか", "みくらふみか")).toBe(false);
    expect(isFamilyNameForm("リン", "アウクトリン")).toBe(false);
  });

  test("末尾が重ならなければ結ばない", () => {
    expect(isFamilyNameForm("文佳", "文佳ちゃん")).toBe(false);
    expect(isFamilyNameForm("密倉", "密倉文佳")).toBe(false);
  });

  test("候補として挙げる。自動では統合しない", () => {
    const characters = [character("三門太志"), character("太志")];

    expect(findMergeCandidates(characters)).toContainEqual({
      names: ["三門太志", "太志"],
      reason: "name_part",
    });
    expect(characters).toHaveLength(2);
  });

  test("同じ呼び名で既に拾えている組を、二重に挙げない", () => {
    // 密倉文佳の別名に「文佳」がある。same_name で拾うので name_part は出さない
    const characters = [character("密倉文佳", ["文佳"]), character("文佳")];

    const reasons = findMergeCandidates(characters).map(
      (candidate) => candidate.reason
    );
    expect(reasons).toEqual(["same_name"]);
  });
});

describe("統合候補への反映", () => {
  test("候補として挙げる。自動では統合しない", () => {
    const characters = [character("近所のおばあさん"), character("ばあさん")];

    const candidates = findMergeCandidates(characters);

    expect(candidates).toContainEqual({
      names: ["近所のおばあさん", "ばあさん"],
      reason: "suffix",
    });
    // 候補を出すだけで、レコードは触らない
    expect(characters).toHaveLength(2);
  });

  test("別名どうしでも拾う", () => {
    const characters = [
      character("密倉 文佳", ["文佳"]),
      character("転校生", ["密倉さん"]),
    ];

    // 「密倉さん」は「密倉 文佳」の末尾ではないので、この手掛かりでは拾わない。
    // 拾えないこと自体を固定しておく（誤検出を増やして直したくなるため）
    expect(
      findMergeCandidates(characters).some(
        (candidate) => candidate.reason === "suffix"
      )
    ).toBe(false);
  });

  test("無関係な人物どうしを結ばない", () => {
    const characters = [
      character("春原 月夜"),
      character("斉藤"),
      character("黒木"),
    ];

    expect(findMergeCandidates(characters)).toEqual([]);
  });
});
