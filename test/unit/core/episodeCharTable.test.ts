import { describe, expect, test } from "vitest";
import { buildEpisodeCountTable } from "../../../src/core/episodeCharTable";
import type { EpisodeFile } from "../../../src/models/types";

/** 走査結果の1件。文字数まわり以外は既定値でよい */
function episode(
  fileName: string,
  net: number,
  overrides: Partial<EpisodeFile> = {}
): EpisodeFile {
  return {
    filePath: `C:/work/本文/${fileName}`,
    fileName,
    ext: ".txt",
    chapterStart: null,
    chapterEnd: null,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: {
      gross: net,
      net,
      lines: 10,
      paragraphs: 5,
      // 1行20字で折り返した行数。枚数の合算を確かめるのに使う
      manuscriptLines: Math.ceil(net / 20),
    },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
    ...overrides,
  };
}

describe("話ごとの文字数一覧", () => {
  test("平均から大きく外れた話に印を付ける", () => {
    // 極端に短い話・長い話は、投稿の間隔や読者の離脱に効く
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000),
      episode("002.txt", 2_000),
      episode("003.txt", 2_000),
      episode("004.txt", 300),
      episode("005.txt", 9_000),
    ]);

    const flags = table.rows.map((row) => row.flag);
    expect(flags).toEqual([null, null, null, "short", "long"]);
  });

  test("話数が少ないうちは印を付けない", () => {
    // 2話しかなければ片方は必ず平均より上になる。平均自体が当てにならない
    const table = buildEpisodeCountTable([
      episode("001.txt", 500),
      episode("002.txt", 5_000),
    ]);

    expect(table.rows.every((row) => row.flag === null)).toBe(true);
  });

  test("競合中の話は字数に数えず、行としては残す", () => {
    // 数えないだけで、存在まで消すと作者は何が抜けたか分からない
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000),
      episode("002.txt", 0, { hasConflictMarkers: true }),
    ]);

    expect(table.rows).toHaveLength(2);
    expect(table.summary.countedFiles).toBe(1);
    expect(table.summary.conflictedFiles).toBe(1);
    expect(table.summary.totalNet).toBe(2_000);
    expect(table.rows[1].flag).toBeNull();
  });

  test("原稿用紙の枚数は行数を合算してから換算する", () => {
    // ファイルごとに切り上げて足すと、端数が積み上がって実際より多くなる
    const table = buildEpisodeCountTable([
      episode("001.txt", 210),
      episode("002.txt", 210),
    ]);

    // 各11行 → 合計22行 → 2枚（1枚ずつ切り上げると2枚だが、
    // 行で合算しないと端数が増えていく）
    expect(table.summary.totalPages).toBe(2);
  });

  test("中央値も出す", () => {
    // 平均だけでは、1話だけ極端に長いときに実感と合わなくなる
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000),
      episode("002.txt", 2_100),
      episode("003.txt", 2_200),
      episode("004.txt", 20_000),
    ]);

    expect(table.summary.medianNet).toBe(2_150);
    expect(table.summary.averageNet).toBe(6_575);
  });

  test("いちばん長い話と短い話を指す", () => {
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000),
      episode("002.txt", 500),
      episode("003.txt", 9_000),
    ]);

    expect(table.summary.longest?.fileName).toBe("003.txt");
    expect(table.summary.shortest?.fileName).toBe("002.txt");
  });

  test("話数の見出しとタイトルを作る", () => {
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000, {
        chapterStart: 1,
        chapterEnd: 1,
        metaTitle: "第1話 気がついたら幽霊に",
      }),
      episode("序章.txt", 1_000, { kind: "プロローグ" }),
    ]);

    // 見出しに「第1話」が出るので、タイトル側からは落とす
    expect(table.rows[0]).toMatchObject({
      chapterLabel: "第1話",
      title: "気がついたら幽霊に",
    });
    expect(table.rows[1].chapterLabel).toBe("プロローグ");
  });

  test("本文が1件も無くても壊れない", () => {
    const table = buildEpisodeCountTable([]);

    expect(table.rows).toEqual([]);
    expect(table.summary).toMatchObject({
      countedFiles: 0,
      averageNet: 0,
      medianNet: 0,
      longest: null,
      shortest: null,
    });
  });
});

describe("合本は平均に混ぜない（設計書6.3）", () => {
  /** 3話入りの合本1件＋普通の話3件 */
  const mixed = () => [
    episode("001.txt", 2_000),
    episode("002.txt", 2_100),
    episode("003.txt", 2_200),
    episode("全話.txt", 700_000, { collectedCount: 219 }),
  ];

  test("平均・中央値は、合本を除いた話だけから出す", () => {
    // 合本の net は中の全話の合計なので、混ぜると平均が跳ね上がり、
    // 普通の話が軒並み「短い」と判定される
    const table = buildEpisodeCountTable(mixed());

    expect(table.summary.averageNet).toBe(2_100);
    expect(table.summary.medianNet).toBe(2_100);
    expect(table.summary.collectedFiles).toBe(1);
  });

  test("合本の行には長短の印を付けない", () => {
    // 1話ぶんの長さではないので、長い・短いを言えない
    const table = buildEpisodeCountTable(mixed());

    expect(table.rows[3].collectedCount).toBe(219);
    expect(table.rows[3].flag).toBeNull();
  });

  test("合本しかない作品では、偏りの判定をしない", () => {
    // 比べる相手が1件も無いのに「短い」と言うことはできない
    const table = buildEpisodeCountTable([
      episode("前半.txt", 300_000, { collectedCount: 100 }),
      episode("中盤.txt", 10_000, { collectedCount: 3 }),
      episode("後半.txt", 400_000, { collectedCount: 119 }),
      episode("番外.txt", 5_000, { collectedCount: 2 }),
    ]);

    expect(table.rows.every((row) => row.flag === null)).toBe(true);
    expect(table.summary.averageNet).toBe(0);
  });

  test("いちばん長い話・短い話も、合本は選ばない", () => {
    const table = buildEpisodeCountTable(mixed());

    expect(table.summary.longest?.fileName).toBe("003.txt");
    expect(table.summary.shortest?.fileName).toBe("001.txt");
  });

  test("合本が無い作品の数字は変わらない", () => {
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000),
      episode("002.txt", 2_100),
      episode("003.txt", 2_200),
    ]);

    expect(table.summary.averageNet).toBe(2_100);
    expect(table.summary.medianNet).toBe(2_100);
    expect(table.summary.collectedFiles).toBe(0);
    // 合計は作品ぜんたいの字数なので、母集団とは別に全件を足す
    expect(table.summary.totalNet).toBe(6_300);
  });

  test("合計字数には合本も入れる", () => {
    // 「この作品は何字あるか」からは、合本の中身を外せない
    const table = buildEpisodeCountTable(mixed());

    expect(table.summary.totalNet).toBe(706_300);
    expect(table.summary.countedFiles).toBe(4);
  });
});

/**
 * 種類の目安（設計書6.109.7）。執筆量パネルの話ごとの一覧にも、
 * 原稿エディタ・作品一覧と同じ部品（`core/kindMeasure.ts`）で出す。
 */
describe("話ごとの一覧に、種類の目安を添える", () => {
  test("小説では目安を持たない（これまでどおり）", () => {
    const table = buildEpisodeCountTable([episode("001.txt", 1_000)], {
      kind: "novel",
    });
    expect(table.rows[0].measure).toBeNull();
    expect(table.summary.totalMeasure).toBeNull();

    const unknown = buildEpisodeCountTable([episode("001.txt", 1_000)]);
    expect(unknown.rows[0].measure).toBeNull();
    expect(unknown.summary.totalMeasure).toBeNull();
  });

  test("エッセイは話ごとと合計に読了の目安が付く（字数から出す）", () => {
    const table = buildEpisodeCountTable(
      [episode("001.txt", 1_000), episode("002.txt", 600)],
      { kind: "essay" }
    );
    expect(table.rows.map((row) => row.measure)).toEqual([
      "読了 約2分",
      "読了 約2分",
    ]);
    // 合計は字数を足してから割る（話ごとに切り上げた分を積まない）
    expect(table.summary.totalMeasure).toContain("約4分");
  });

  test("台本は400字詰めの枚数から分数を出す", () => {
    const table = buildEpisodeCountTable([episode("001.txt", 1_000)], {
      kind: "script",
    });
    // 1,000字＝50行（20字折り返し）＝3枚（20行で1枚、切り上げ）
    expect(table.rows[0].measure).toBe("約3分");
    expect(table.summary.totalMeasure).toContain("約3枚");
  });

  test("漫画の原作は本文を見て、ページとコマを数える", () => {
    const texts = new Map([
      ["C:/work/本文/001.txt", "■1ページ\n□コマ1\n□コマ2\n■2ページ\n□コマ1\n"],
      ["C:/work/本文/002.txt", "■3ページ\n□コマ1\n"],
    ]);
    const table = buildEpisodeCountTable(
      [episode("001.txt", 30), episode("002.txt", 10)],
      { kind: "manga", texts }
    );
    expect(table.rows.map((row) => row.measure)).toEqual([
      "2ページ・3コマ",
      "1ページ・1コマ",
    ]);
    expect(table.summary.totalMeasure).toContain("3ページ・4コマ");
  });

  test("歌詞の合計は、話をまたいで連がつながらない", () => {
    const texts = new Map([
      ["C:/work/本文/001.txt", "一行目\n二行目"],
      ["C:/work/本文/002.txt", "三行目"],
    ]);
    const table = buildEpisodeCountTable(
      [episode("001.txt", 6), episode("002.txt", 3)],
      { kind: "lyrics", texts }
    );
    expect(table.rows.map((row) => row.measure)).toEqual([
      "1連・2行",
      "1連・1行",
    ]);
    expect(table.summary.totalMeasure).toContain("2連・3行");
  });

  test("中身を読めなかった話があれば、合計の目安は出さない（少なく見せない）", () => {
    const texts = new Map([["C:/work/本文/001.txt", "■1ページ\n"]]);
    const table = buildEpisodeCountTable(
      [episode("001.txt", 5), episode("002.txt", 5)],
      { kind: "manga", texts }
    );
    expect(table.rows.map((row) => row.measure)).toEqual(["1ページ・0コマ", null]);
    expect(table.summary.totalMeasure).toBeNull();
  });

  test("競合のある話は、目安も数えない", () => {
    const table = buildEpisodeCountTable(
      [
        episode("001.txt", 1_000),
        episode("002.txt", 5_000, { hasConflictMarkers: true }),
      ],
      { kind: "essay" }
    );
    expect(table.rows[1].measure).toBeNull();
    expect(table.summary.totalMeasure).toContain("約2分");
  });
});
