import * as path from "path";
import { describe, expect, test } from "vitest";
import {
  applyRenumberPlan,
  planInsertion,
  planRemoval,
  renumberCharacter,
  renumberChapterSet,
  renumberBookPositions,
  renameWithNumber,
  type RenumberEpisode,
} from "../../src/core/episodeRenumber";
import { emptyCharacter } from "../../src/models/character";
import type { Chapter } from "../../src/models/chapter";

/**
 * 話数の付け替え（設計書6.67）。
 *
 * **本文には一切触れない。** ここで決めるのは「どのファイルを何という
 * 名前にするか」と「話数を指している台帳をどうずらすか」だけである。
 */

const DIR = path.join("C:", "novels", "work", "本文");

function ep(fileName: string): RenumberEpisode {
  return { filePath: path.join(DIR, fileName), fileName };
}

/** 001.txt 〜 005.txt */
const numbered = [1, 2, 3, 4, 5].map((n) =>
  ep(`${String(n).padStart(3, "0")}.txt`)
);

describe("ファイル名の話数だけを差し替える", () => {
  test("ゼロ埋めの桁を保つ", () => {
    expect(renameWithNumber("003.txt", 4)).toBe("004.txt");
    expect(renameWithNumber("0003.txt", 12)).toBe("0012.txt");
  });

  test("サブタイトルは1文字も変えない", () => {
    expect(renameWithNumber("007_湖畔の誓い.txt", 8)).toBe("008_湖畔の誓い.txt");
    expect(renameWithNumber("第12話 再会.md", 13)).toBe("第13話 再会.md");
    expect(renameWithNumber("episode_0001_はじまり.txt", 2)).toBe(
      "episode_0002_はじまり.txt"
    );
  });

  test("ゼロ埋めしていない名前には、ゼロを足さない", () => {
    // 「第10話」を9へ詰めるとき「第09話」にすると、作者の書き方が変わる
    expect(renameWithNumber("第10話 別離.txt", 9)).toBe("第9話 別離.txt");
  });

  test("全角の数字は全角のまま返す", () => {
    expect(renameWithNumber("００３_出立.txt", 4)).toBe("００４_出立.txt");
  });

  test("話数を持たない名前は付け替えられない（null）", () => {
    expect(renameWithNumber("プロローグ.txt", 2)).toBeNull();
    expect(renameWithNumber("2026-08-16_海辺の話.txt", 2)).toBeNull();
  });
});

describe("挿入の計画", () => {
  test("挿入位置より後ろだけが +1 され、実行は降順", () => {
    const plan = planInsertion(numbered, 3);
    expect(plan.delta).toBe(1);
    expect(plan.renames.map((r) => [r.fromFileName, r.toFileName])).toEqual([
      ["005.txt", "006.txt"],
      ["004.txt", "005.txt"],
      ["003.txt", "004.txt"],
    ]);
  });

  test("先頭に挿入すると全部が動く", () => {
    const plan = planInsertion(numbered, 1);
    expect(plan.renames).toHaveLength(5);
    expect(plan.renames[0].fromFileName).toBe("005.txt");
    expect(plan.renames[plan.renames.length - 1].fromFileName).toBe("001.txt");
  });

  test("末尾の次に挿入すると、動く話は無い", () => {
    expect(planInsertion(numbered, 6).renames).toHaveLength(0);
  });

  test("話が1つでも通る", () => {
    const plan = planInsertion([ep("001.txt")], 1);
    expect(plan.renames.map((r) => r.toFileName)).toEqual(["002.txt"]);
  });

  test("番号を持たない話は動かさず、動かさなかったものとして返す", () => {
    const episodes = [
      ep("プロローグ.txt"),
      ep("001.txt"),
      ep("002.txt"),
      ep("幕間1.txt"),
      ep("2026-08-16_余話.txt"),
    ];
    const plan = planInsertion(episodes, 1);
    expect(plan.renames.map((r) => r.fromFileName)).toEqual([
      "002.txt",
      "001.txt",
    ]);
    expect(plan.unnumbered).toEqual([
      "プロローグ.txt",
      "幕間1.txt",
      "2026-08-16_余話.txt",
    ]);
  });

  test("話数の範囲を持つ合本は動かさず、理由つきで返す", () => {
    const plan = planInsertion([ep("001.txt"), ep("003-005_合本.txt")], 2);
    expect(plan.renames).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({
      fileName: "003-005_合本.txt",
      reason: "range",
    });
  });

  test("2つの話が同じ名前へ行き着くときは、始める前に知らせる", () => {
    // 「9.txt」と「09.txt」は、どちらも第9話。1つずらすと両方 10.txt になる。
    // 実行してしまってからでは片方が消えている
    const plan = planInsertion([ep("9.txt"), ep("09.txt")], 9);
    expect(plan.collisions.length).toBeGreaterThan(0);
    expect(plan.collisions.map((c) => c.toFileName)).toContain("10.txt");
  });

  test("別のフォルダの同じ名前は、ぶつかりではない", () => {
    // 走査は下の階層まで見る。名前だけで比べると、番外編フォルダの
    // 003.txt を「ぶつかる」と誤って断ってしまう
    const plan = planInsertion(
      [
        ep("003.txt"),
        { filePath: path.join(DIR, "番外", "004.txt"), fileName: "004.txt" },
      ],
      3
    );
    expect(plan.collisions).toHaveLength(0);
  });
});

describe("削除の計画", () => {
  test("削除した話より後ろだけが −1 され、実行は昇順", () => {
    const plan = planRemoval(numbered, path.join(DIR, "003.txt"));
    expect(plan.delta).toBe(-1);
    expect(plan.renames.map((r) => [r.fromFileName, r.toFileName])).toEqual([
      ["004.txt", "003.txt"],
      ["005.txt", "004.txt"],
    ]);
  });

  test("末尾を削除すると、動く話は無い", () => {
    const plan = planRemoval(numbered, path.join(DIR, "005.txt"));
    expect(plan.renames).toHaveLength(0);
  });

  test("削除する話そのものは、ぶつかりに数えない", () => {
    const plan = planRemoval(numbered, path.join(DIR, "003.txt"));
    expect(plan.collisions).toHaveLength(0);
  });

  test("話数を持たない話を指すと、計画を作れない", () => {
    expect(() =>
      planRemoval([ep("プロローグ.txt")], path.join(DIR, "プロローグ.txt"))
    ).toThrow();
  });
});

describe("付け替えの実行", () => {
  test("全部済めば、済んだ一覧だけが返る", async () => {
    const plan = planInsertion(numbered, 3);
    const done: string[] = [];
    const outcome = await applyRenumberPlan(plan, async (from, to) => {
      done.push(`${path.basename(from)}→${path.basename(to)}`);
    });
    expect(outcome.stoppedAt).toBeUndefined();
    expect(outcome.done).toHaveLength(3);
    expect(done).toEqual([
      "005.txt→006.txt",
      "004.txt→005.txt",
      "003.txt→004.txt",
    ]);
  });

  test("1件でも失敗したらそこで止まり、どこまで進んだかが分かる", async () => {
    const plan = planInsertion(numbered, 3);
    const outcome = await applyRenumberPlan(plan, async (from) => {
      if (path.basename(from) === "004.txt") throw new Error("使用中です");
    });
    expect(outcome.done.map((r) => r.fromFileName)).toEqual(["005.txt"]);
    expect(outcome.stoppedAt?.rename.fromFileName).toBe("004.txt");
    expect(outcome.stoppedAt?.detail).toContain("使用中です");
  });
});

describe("パスで指している台帳の追従", () => {
  const moves = new Map([["本文/003.txt", "本文/004.txt"]]);

  test("章立ての開始の話が付いてくる", () => {
    const chapters: Chapter[] = [
      { name: "第一章", startEpisodePath: "本文/001.txt" },
      { name: "第二章", startEpisodePath: "本文/003.txt" },
    ];
    const result = renumberChapterSet(chapters, moves);
    expect(result.changed).toBe(1);
    expect(result.chapters[1].startEpisodePath).toBe("本文/004.txt");
    expect(result.chapters[0].startEpisodePath).toBe("本文/001.txt");
  });

  test("挿絵とページ分割の指し先が付いてくる", () => {
    const result = renumberBookPositions(
      {
        illustrations: [
          { episodePath: "本文/003.txt", afterParagraph: 2, imagePath: "a.png", caption: "" },
          { episodePath: "本文/001.txt", afterParagraph: 1, imagePath: "b.png", caption: "" },
        ],
        pageBreaks: [{ episodePath: "本文/003.txt", afterParagraph: 5 }],
      },
      moves
    );
    // 挿絵1件とページ分割1件が動く（001.txt の挿絵は動かない）
    expect(result.changed).toBe(2);
    expect(result.illustrations[0].episodePath).toBe("本文/004.txt");
    expect(result.illustrations[1].episodePath).toBe("本文/001.txt");
    expect(result.pageBreaks[0].episodePath).toBe("本文/004.txt");
  });

  test("指し先が消えたものは黙って消さず、数えて返す", () => {
    const result = renumberBookPositions(
      {
        illustrations: [
          { episodePath: "本文/009.txt", afterParagraph: 2, imagePath: "a.png", caption: "" },
        ],
        pageBreaks: [],
      },
      moves,
      "本文/009.txt"
    );
    expect(result.illustrations).toHaveLength(1);
    expect(result.orphaned).toBe(1);
  });
});

describe("話数の数字で指している台帳の追従", () => {
  function personWithChapters() {
    const person = emptyCharacter("char_001", "月島灯");
    person.appearedChapters = [1, 3, 5];
    person.firstPerson.variants = [
      { form: "俺", context: null, chapters: [2, 4], evidence: null },
    ];
    person.changes = [
      {
        field: "hair",
        value: "銀髪",
        chapters: [1, 4],
        timepointId: null,
        note: null,
        evidence: null,
        source: "extracted",
      },
    ];
    person.conflicts = [
      {
        field: "eyes",
        values: ["青", "碧"],
        chapters: [2, 5],
        note: null,
        observations: [
          { value: "青", chapters: [2] },
          { value: "碧", chapters: [5] },
        ],
      },
    ];
    return person;
  }

  test("挿入位置より後ろの話数だけが +1 される", () => {
    const result = renumberCharacter(personWithChapters(), {
      pivot: 3,
      delta: 1,
    });
    expect(result.character.appearedChapters).toEqual([1, 4, 6]);
    expect(result.character.firstPerson.variants[0].chapters).toEqual([2, 5]);
    expect(result.character.changes[0].chapters).toEqual([1, 5]);
    expect(result.character.conflicts[0].chapters).toEqual([2, 6]);
    expect(result.character.conflicts[0].observations?.[1].chapters).toEqual([6]);
    // 1・3・5 のうち2つ、2・4 のうち1つ、1・4 のうち1つ、2・5 のうち1つ、
    // 観測の 5 が1つ = 6件
    expect(result.changed).toBe(6);
  });

  test("挿入位置より前は動かない", () => {
    const result = renumberCharacter(personWithChapters(), {
      pivot: 9,
      delta: 1,
    });
    expect(result.changed).toBe(0);
    expect(result.character.appearedChapters).toEqual([1, 3, 5]);
  });

  test("削除では、後ろが −1 され、消えた話の番号だけが落ちる", () => {
    const result = renumberCharacter(personWithChapters(), {
      pivot: 3,
      delta: -1,
      removed: 3,
    });
    // 3 は消え、5 は 4 へ詰まる
    expect(result.character.appearedChapters).toEqual([1, 4]);
    // 値そのもの（銀髪・青・碧）は1つも消えない
    expect(result.character.changes[0].value).toBe("銀髪");
    expect(result.character.conflicts[0].values).toEqual(["青", "碧"]);
  });

  test("元の人物は書き換えない（保存に失敗しても画面が食い違わない）", () => {
    const person = personWithChapters();
    renumberCharacter(person, { pivot: 1, delta: 1 });
    expect(person.appearedChapters).toEqual([1, 3, 5]);
  });
});
