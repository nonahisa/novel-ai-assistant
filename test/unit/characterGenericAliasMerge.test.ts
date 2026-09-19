import { describe, expect, test } from "vitest";
import { mergeExtractedCharacters } from "../../src/core/characterMerge";
import { validateCharacterExtractResult } from "../../src/core/characterExtractionValidation";
import type { Chunk } from "../../src/core/chunker";
import type { ExtractedCharacter } from "../../src/prompts/characterExtract";

/**
 * 実データで見つかった不具合の再現（2026-09-19の実機確認）。
 *
 * 作品「転生した受験生の異世界成り上がり ～別視点バージョン～」で、
 * **AIの生出力は4人をきちんと分けていた**のに、保存後の設定資料では
 * 2人ずつが1件へ潰れていた。
 *
 *   リナちゃん[リナ・ちっちゃい女の子・御子息・イント君・イント・…]
 *   シーゲン子爵[父上・お父さん・ユニィ・シーゲン・ユニィ様・…]
 *
 * 壊したのは製品側の名寄せである。橋渡しは2つあった。
 *  ① イントとリナが両方「御子息」を別名に持っていた（誰にでも使う呼び方）
 *  ② 「シーゲン子爵」は爵位を外すと「シーゲン」＝娘のフルネームの家名になる
 *
 * ここは `.aiwriter/cache/chunks.json` に残っていた第1話の出力をそのまま写す。
 */

/** 第1話でAIが返した6人（キャッシュの値をそのまま写した） */
function firstChapterExtraction(): Array<{
  data: ExtractedCharacter;
  chapters: number[];
}> {
  const people: ExtractedCharacter[] = [
    {
      name: "リナちゃん",
      aliases: ["リナ", "ちっちゃい女の子", "御子息"],
      role: "領主の御子息",
      summary: "領主の娘。驚異的な脚力を持つ明朗な少女。",
    },
    {
      name: "イント君",
      aliases: ["イント", "小さな男の子", "御子息"],
      role: "領主の御子息",
      summary: "栗色の髪の少年。リナの兄。",
    },
    { name: "シーゲン子爵", aliases: ["父上", "お父さん"], role: "領主" },
    {
      name: "ユニィ・シーゲン",
      aliases: ["ユニィ様", "シーゲン子爵の娘"],
      role: "領主の娘",
      summary: "イントと同い年の少女。",
    },
    {
      name: "ヴォイド",
      aliases: ["ヴォイド様", "コンストラクタ村の領主", "お師匠様"],
      role: "コンストラクタ村の領主",
    },
    { name: "パッケ", aliases: ["執事さん", "執事"], role: "執事" },
  ];
  return people.map((data) => ({ data, chapters: [1] }));
}

describe("誰にでも使う呼び方で別人を1人にしない", () => {
  test("第1話の6人が6件のまま残る", () => {
    const result = mergeExtractedCharacters([], firstChapterExtraction());

    expect(result.characters.map((c) => c.name)).toEqual([
      "リナちゃん",
      "イント君",
      "シーゲン子爵",
      "ユニィ・シーゲン",
      "ヴォイド",
      "パッケ",
    ]);
  });

  test("「御子息」を両方が別名に持つだけでは統合しない", () => {
    // 実際の壊れ方：イント（主人公）が妹のレコードへ吸収された
    const result = mergeExtractedCharacters([], [
      {
        data: { name: "リナちゃん", aliases: ["リナ", "御子息"] },
        chapters: [1],
      },
      {
        data: { name: "イント君", aliases: ["イント", "御子息"] },
        chapters: [1],
      },
    ]);

    expect(result.characters).toHaveLength(2);
    const rina = result.characters.find((c) => c.name === "リナちゃん");
    expect(rina?.aliases ?? []).not.toContain("イント");
  });

  test("家族関係語（「お父さん」）を共有しても統合しない", () => {
    const result = mergeExtractedCharacters([], [
      { data: { name: "シーゲン子爵", aliases: ["父上", "お父さん"] }, chapters: [1] },
      { data: { name: "ヴォイド", aliases: ["ヴォイド様", "お父さん"] }, chapters: [1] },
    ]);

    expect(result.characters).toHaveLength(2);
  });

  test("一般語でしか重ならない組は統合候補にも出さない", () => {
    // 「御子息」が両方にあるだけで「同じ人かも」と毎回聞かれては、
    // 作者は候補を読まなくなる
    const result = mergeExtractedCharacters([], [
      { data: { name: "リナちゃん", aliases: ["御子息"] }, chapters: [1] },
      { data: { name: "イント君", aliases: ["御子息"] }, chapters: [1] },
    ]);

    expect(result.mergeCandidates).toEqual([]);
  });
});

describe("爵位で呼ばれる名前は家名である", () => {
  test("「シーゲン子爵」が娘「ユニィ・シーゲン」を吸収しない", () => {
    // 「シーゲン子爵」は敬称（爵位）を外すと「シーゲン」になり、
    // 娘のフルネームの家名と一致してしまう。家名は同一人物の証拠にならない
    const result = mergeExtractedCharacters([], [
      { data: { name: "シーゲン子爵", aliases: ["父上", "お父さん"] }, chapters: [1] },
      {
        data: {
          name: "ユニィ・シーゲン",
          aliases: ["ユニィ様", "シーゲン子爵の娘"],
          summary: "イントと同い年の少女。",
        },
        chapters: [1],
      },
    ]);

    expect(result.characters).toHaveLength(2);
    const father = result.characters.find((c) => c.name === "シーゲン子爵");
    expect(father?.aliases ?? []).not.toContain("ユニィ様");
    // 紹介文まで娘のものへ書き換わっていた
    expect(father?.summary ?? "").not.toContain("同い年");
    // 「同じ人かも」とも出さない。作者が誘われて手で統合すれば同じ壊れ方になる。
    // 読み（ゆにぃしーげん）の末尾が父の「シーゲン」と重なるが、
    // 中黒区切りの名前の末尾は姓であって、同一人物の証拠にならない
    expect(result.mergeCandidates).toEqual([]);
  });

  test("爵位付きの名前が既にある状態でも、家名だけでは寄せない", () => {
    const seeded = mergeExtractedCharacters([], [
      { data: { name: "シーゲン子爵" }, chapters: [1] },
    ]);
    const result = mergeExtractedCharacters(seeded.characters, [
      { data: { name: "ユニィ・シーゲン" }, chapters: [2] },
    ]);

    expect(result.characters).toHaveLength(2);
  });

  // ここから逆順（2026-09-19の実機で再現）。
  // 0.68.7 は「既存が爵位名・入ってくるのがフルネーム」だけを塞いでいた。
  // AIが娘を先に返すと向きが逆になり、今度は父が娘へ吸い込まれる。
  test("娘「ユニィ・シーゲン」が先でも、父「シーゲン子爵」を吸収しない", () => {
    const result = mergeExtractedCharacters([], [
      {
        data: {
          name: "ユニィ・シーゲン",
          aliases: ["ユニィ様"],
          summary: "シーゲン子爵の娘。",
        },
        chapters: [1],
      },
      {
        data: {
          name: "シーゲン子爵",
          aliases: ["シーゲン子爵"],
          summary: "この街の領主。",
        },
        chapters: [1],
      },
    ]);

    expect(result.characters).toHaveLength(2);
    const daughter = result.characters.find((c) => c.name === "ユニィ・シーゲン");
    expect(daughter?.aliases ?? []).not.toContain("シーゲン子爵");
    expect(daughter?.summary ?? "").not.toContain("領主");
    // 「同じ人かも」とも出さない（父先の向きと同じ理由）
    expect(result.mergeCandidates).toEqual([]);
  });

  test("フルネームが既にある状態でも、爵位名は別レコードになる", () => {
    const seeded = mergeExtractedCharacters([], [
      { data: { name: "ユニィ・シーゲン" }, chapters: [1] },
    ]);
    const result = mergeExtractedCharacters(seeded.characters, [
      { data: { name: "シーゲン子爵" }, chapters: [2] },
    ]);

    expect(result.characters).toHaveLength(2);
  });

  test("実機で父が消えた並び（娘が3番目・父が7番目）をそのまま流す", () => {
    // 手元の Ollama（gemma4:26b）が返した順。9人のはずが8人になり、
    // 「シーゲン子爵」が娘の別名として吸い込まれていた
    const result = mergeExtractedCharacters([], [
      { data: { name: "マイナ", aliases: ["わたし"], summary: "算術を教える教師。" }, chapters: [1] },
      { data: { name: "ターナ", aliases: ["母さん", "ターナ先生"], summary: "マイナの母。" }, chapters: [1] },
      { data: { name: "ユニィ・シーゲン", aliases: ["ユニィ様"], summary: "シーゲン子爵の娘。" }, chapters: [1] },
      { data: { name: "ヴォイド", aliases: ["ヴォイド様"], summary: "コンストラクタ村の領主。" }, chapters: [1] },
      { data: { name: "イント", aliases: ["イント君", "イント様"], summary: "ヴォイドの息子。" }, chapters: [1] },
      { data: { name: "リナ", aliases: ["リナちゃん", "リナ"], summary: "ヴォイドの娘でイントの妹。" }, chapters: [1] },
      { data: { name: "シーゲン子爵", aliases: ["シーゲン子爵"], summary: "この街の領主。" }, chapters: [1] },
      { data: { name: "ジェクティ", aliases: ["ジェクティ様"], summary: "コンストラクタ家の人間。" }, chapters: [1] },
      { data: { name: "オバラ", aliases: ["オバラさん", "院長先生"], summary: "治療院の院長。" }, chapters: [1] },
    ]);

    expect(result.characters.map((c) => c.name)).toEqual([
      "マイナ",
      "ターナ",
      "ユニィ・シーゲン",
      "ヴォイド",
      "イント",
      "リナ",
      "シーゲン子爵",
      "ジェクティ",
      "オバラ",
    ]);
  });
});

describe("同じ人は分裂させない", () => {
  test("「イント君」と「イント」は同じ人のまま", () => {
    const result = mergeExtractedCharacters([], [
      { data: { name: "イント君", aliases: ["小さな男の子"] }, chapters: [1] },
      { data: { name: "イント", aliases: ["イント様"] }, chapters: [4] },
    ]);

    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].appearedChapters).toEqual([1, 4]);
  });

  test("一般語が片方の主たる名前なら、これまでどおり寄せる", () => {
    // 「執事」としか呼ばれない人物は、名前が分かっているレコードへ寄せたい
    const result = mergeExtractedCharacters([], [
      { data: { name: "パッケ", aliases: ["執事さん", "執事"] }, chapters: [1] },
      { data: { name: "執事", aliases: ["執事姿の男性"] }, chapters: [2] },
    ]);

    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].name).toBe("パッケ");
  });

  test("フルネームと名だけの呼び方は、これまでどおり寄せる", () => {
    const result = mergeExtractedCharacters([], [
      { data: { name: "マイナ・ノースウッド" }, chapters: [1] },
      { data: { name: "マイナ" }, chapters: [2] },
    ]);

    expect(result.characters).toHaveLength(1);
  });

  test("爵位を含むフルネームは、これまでどおり同一人物", () => {
    const result = mergeExtractedCharacters([], [
      { data: { name: "ヴォイド・コンストラクタ男爵" }, chapters: [1] },
      { data: { name: "ヴォイド・コンストラクタ" }, chapters: [2] },
    ]);

    expect(result.characters).toHaveLength(1);
  });
});

describe("役割語は別名として採らない", () => {
  const line = "領主の御子息であるイント君と、妹のリナちゃんが並んでいた。";
  const chunk: Chunk = {
    filePath: "001.txt",
    index: 0,
    text: line,
    startLine: 0,
    hash: "fixture",
    chapterStart: 1,
    chapterEnd: 1,
  };

  test.each([["御子息"], ["ご子息"], ["子息"], ["執事"], ["領主"]])(
    "%s を別名から落とす",
    (alias) => {
      const result = validateCharacterExtractResult(
        {
          characters: [
            { name: "イント君", aliases: ["イント", alias], evidence: line },
          ],
        },
        chunk
      );

      expect(result.accepted[0]?.data.aliases ?? []).not.toContain(alias);
      expect(result.accepted[0]?.data.aliases ?? []).toContain("イント");
    }
  );
});
