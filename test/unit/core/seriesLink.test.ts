import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  copyFromSeriesCandidate,
  findSeriesCharacterMatches,
  findSiblingWorks,
  isPlainFolderName,
  isShareableRecord,
  parseSeriesConfig,
  resolveRelatedWorkPaths,
  shouldOfferSeriesLink,
  type SeriesCharacterCandidate,
} from "../../../src/core/seriesLink";
import { parseWorkConfig } from "../../../src/core/workRegistry";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";
import * as path from "node:path";

/**
 * シリーズ作品を、設定資料でゆるくつなぐ（設計書6.95）の決めごと。
 *
 * **ここは画面を押さずに測れる部分だけ**を見る。相手のフォルダーを実際に
 * 読むところは `seriesSettings.test.ts`。
 */

function candidate(
  over: Partial<SeriesCharacterCandidate> = {}
): SeriesCharacterCandidate {
  return {
    name: "イント",
    reading: "いんと",
    aliases: ["坊ちゃん"],
    summary: "化学を活用しながら戦う主人公",
    sourceTitle: "教科書チート",
    sourceFolderName: "教科書チート",
    ...over,
  };
}

const baseConfig = {
  schemaVersion: "0.1",
  workTitle: "別視点",
  manuscriptDir: "本文",
  settingsDir: "設定",
  createdAt: "2026-09-19T00:00:00.000Z",
};

describe("作品設定の series を読む（設計書6.95.2）", () => {
  it("series が無い既存の作品も、これまでどおり読める", () => {
    const config = parseWorkConfig(baseConfig);
    expect(config.workTitle).toBe("別視点");
    expect(config.series).toBeUndefined();
  });

  it("壊れた series は捨てるが、ほかの欄は読める", () => {
    const config = parseWorkConfig({
      ...baseConfig,
      series: { name: 42, related: "教科書チート" },
    });
    expect(config.series).toBeUndefined();
    expect(config.settingsDir).toBe("設定");
  });

  it("フォルダー名だけを受け取り、パスらしいものは捨てる", () => {
    const parsed = parseSeriesConfig({
      name: "教科書チートの世界",
      related: [
        "教科書チート",
        "C:\\Users\\nonah\\Documents\\novel\\教科書チート",
        "../教科書チート",
        "..",
        "",
      ],
    });
    expect(parsed?.related).toEqual(["教科書チート"]);
  });

  it("受け取れる相手が1つも無ければ、series ごと持たない", () => {
    expect(
      parseSeriesConfig({ name: "シリーズ", related: ["../外", ".."] })
    ).toBeUndefined();
  });

  it("フォルダー名かどうかを、区切りと遡りで判定する", () => {
    expect(isPlainFolderName("教科書チート")).toBe(true);
    expect(isPlainFolderName("小説/教科書チート")).toBe(false);
    expect(isPlainFolderName("..")).toBe(false);
  });
});

describe("相手の場所は、自分の親から組み立てる（設計書6.95.2）", () => {
  it("同じ親フォルダーの子として解決する", () => {
    const resolved = resolveRelatedWorkPaths("C:\\小説\\別視点", {
      name: "教科書チートの世界",
      related: ["教科書チート"],
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].folderName).toBe("教科書チート");
    expect(resolved[0].folderPath).toBe(path.join("C:\\小説", "教科書チート"));
  });

  it("自分自身を相手に書かれても外す", () => {
    const resolved = resolveRelatedWorkPaths("C:\\小説\\別視点", {
      name: "シリーズ",
      related: ["別視点", "教科書チート"],
    });
    expect(resolved.map((item) => item.folderName)).toEqual(["教科書チート"]);
  });

  it("series が無ければ、相手は1つも出ない", () => {
    expect(resolveRelatedWorkPaths("C:\\小説\\別視点", undefined)).toEqual([]);
  });
});

describe("spoilerLevel を越えない（設計書6.95.3）", () => {
  it("public かつ 登場済み のものだけ借りる", () => {
    expect(
      isShareableRecord({ spoilerLevel: "public", status: "登場済み" })
    ).toBe(true);
  });

  it("まだ登場していない人物は借りない", () => {
    expect(
      isShareableRecord({ spoilerLevel: "public", status: "未登場" })
    ).toBe(false);
  });

  it("作者だけ・編集部だけの人物は借りない", () => {
    expect(
      isShareableRecord({ spoilerLevel: "author_only", status: "登場済み" })
    ).toBe(false);
    expect(
      isShareableRecord({ spoilerLevel: "staff_only", status: "登場済み" })
    ).toBe(false);
  });

  it("欄が欠けているレコードは、読まない側に倒す", () => {
    expect(isShareableRecord({})).toBe(false);
    expect(isShareableRecord({ spoilerLevel: "public" })).toBe(false);
  });
});

describe("人物は候補として並べるだけ（設計書6.95.3）", () => {
  it("同じ名前を候補として返す。合体はしない", () => {
    const matched = findSeriesCharacterMatches("イント", [candidate()]);
    expect(matched).toHaveLength(1);
    expect(matched[0].sourceTitle).toBe("教科書チート");
  });

  it("相手の別名で呼ばれている人物も候補にする", () => {
    expect(findSeriesCharacterMatches("坊ちゃん", [candidate()])).toHaveLength(
      1
    );
  });

  it("名前が違えば候補にしない", () => {
    expect(findSeriesCharacterMatches("リナ", [candidate()])).toEqual([]);
  });

  it("写すのは空いている欄だけ。作者が書いた値は残る", () => {
    const mine = {
      name: "イント",
      reading: "いんと（別視点）",
      summary: "語り手から見た少年",
      aliases: ["少年"],
    };
    const copied = copyFromSeriesCandidate(mine, candidate());
    expect(copied.reading).toBe("いんと（別視点）");
    expect(copied.summary).toBe("語り手から見た少年");
    expect(copied.aliases).toEqual(["少年", "坊ちゃん"]);
  });

  it("空いている欄には、相手の紹介と読み仮名を写す", () => {
    const mine = {
      name: "イント",
      reading: null,
      summary: null,
      aliases: [] as string[],
    };
    const copied = copyFromSeriesCandidate(mine, candidate());
    expect(copied.reading).toBe("いんと");
    expect(copied.summary).toBe("化学を活用しながら戦う主人公");
    expect(copied.aliases).toEqual(["坊ちゃん"]);
  });
});

describe("登録したときに気づかせるのは、1度だけ（設計書6.95.4）", () => {
  const works = [
    { folderPath: "C:\\小説\\教科書チート" },
    { folderPath: "C:\\小説\\別視点" },
  ];
  const added = { folderPath: "C:\\小説\\別視点" };

  it("書庫に隣の作品があれば勧める", () => {
    expect(
      shouldOfferSeriesLink({
        works,
        added,
        addedHasSeries: false,
        alreadyOffered: false,
      })
    ).toBe(true);
  });

  it("一度勧めたら、もう勧めない", () => {
    expect(
      shouldOfferSeriesLink({
        works,
        added,
        addedHasSeries: false,
        alreadyOffered: true,
      })
    ).toBe(false);
  });

  it("すでにつないである作品では勧めない", () => {
    expect(
      shouldOfferSeriesLink({
        works,
        added,
        addedHasSeries: true,
        alreadyOffered: false,
      })
    ).toBe(false);
  });

  it("隣に作品が無ければ勧めない", () => {
    expect(
      shouldOfferSeriesLink({
        works: [{ folderPath: "C:\\別の場所\\教科書チート" }, added],
        added,
        addedHasSeries: false,
        alreadyOffered: false,
      })
    ).toBe(false);
  });

  it("隣は同じ親フォルダーの子だけを数える", () => {
    expect(
      findSiblingWorks(
        [
          { folderPath: "C:\\小説\\教科書チート" },
          { folderPath: "C:\\小説\\別視点" },
          { folderPath: "D:\\ほか\\短編" },
        ],
        added
      ).map((work) => work.folderPath)
    ).toEqual(["C:\\小説\\教科書チート"]);
  });
});

/**
 * **矛盾検知の材料に加えない**（作者の裁定、設計書6.95.3）。
 *
 * 別視点は「語り手が知らない」だけのことが矛盾に見えるため、誤検出が増える。
 * 言葉で書くだけでは、あとから材料を組み立てる関数に足されても気づけない。
 * **静的 import をたどって、届かないことを機械で見る。**
 */
describe("矛盾検知にシリーズの資料が混ざらない（設計書6.95.3）", () => {
  const entries = [
    path.join(SRC, "features", "checkContradictions.ts"),
    path.join(SRC, "core", "contradictionMaterial.ts"),
    path.join(SRC, "features", "checkFactContradictions.ts"),
  ];

  it("矛盾検知の起点が実在する", () => {
    expect(entries.filter((file) => !fs.existsSync(file))).toEqual([]);
  });

  it("矛盾検知から、シリーズの資料を読む口へ届かない", () => {
    const seriesReader = path.join(SRC, "core", "seriesSettings.ts");
    for (const entry of entries) {
      const reach = walkStaticImports([entry]);
      expect(
        reach.files.has(seriesReader)
          ? chainTo(reach, seriesReader)
          : relativeName(entry)
      ).toBe(relativeName(entry));
    }
  });
});
