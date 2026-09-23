import { describe, expect, test } from "vitest";
import {
  findLatestEpisode,
  isBlankEpisode,
  isBlankText,
  planLatestEpisode,
} from "../../src/core/latestEpisode";
import type { EpisodeFile } from "../../src/models/types";

/**
 * 「最新話を書く」（作者の依頼、2026-08-27。設計書6.25.5）。
 *
 * 押すたびに空のファイルが増える／書きかけの話を飛ばして次を作る、のどちらも
 * 起きてはいけない。**どちらも原稿に関わる**ので、判断はここで固める。
 */

function episode(
  fileName: string,
  chapter: number | null,
  gross: number
): EpisodeFile {
  return {
    filePath: `C:/work/本文/${fileName}`,
    fileName,
    ext: ".txt",
    chapterStart: chapter,
    chapterEnd: chapter,
    subtitle: null,
    kind: "本編",
    isInitialName: true,
    counts: { net: gross, gross, paragraphs: 0, manuscriptLines: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
  } as unknown as EpisodeFile;
}

const naming = { digits: 3, extension: ".txt" };
const format = (chapter: number, rule: typeof naming) =>
  `${String(chapter).padStart(rule.digits, "0")}${rule.extension}`;

describe("いちばん新しい話を選ぶ", () => {
  test("話数で選ぶ", () => {
    // 並び順や更新時刻では決めない。並びは名前で変わり、時刻は同期で変わる
    const episodes = [
      episode("001.txt", 1, 100),
      episode("010.txt", 10, 100),
      episode("002.txt", 2, 100),
    ];

    expect(findLatestEpisode(episodes)?.fileName).toBe("010.txt");
  });

  test("話数の読めないものしか無ければ、最後のものを最新とみなす", () => {
    const episodes = [episode("プロローグ.txt", null, 100), episode("幕間.txt", null, 100)];

    expect(findLatestEpisode(episodes)?.fileName).toBe("幕間.txt");
  });

  test("1話も無ければ、選べない", () => {
    expect(findLatestEpisode([])).toBeUndefined();
  });
});

describe("何を開くかを決める", () => {
  test("最新話が白紙なら、それを開く", () => {
    // **押すたびに空のファイルが増えない**ようにする
    const episodes = [episode("001.txt", 1, 500), episode("002.txt", 2, 0)];

    expect(planLatestEpisode(episodes, isBlankEpisode, naming, format)).toEqual({
      kind: "open",
      episode: episodes[1],
    });
  });

  test("最新話に本文があれば、次の話を作る", () => {
    const episodes = [episode("001.txt", 1, 500), episode("002.txt", 2, 800)];

    expect(planLatestEpisode(episodes, isBlankEpisode, naming, format)).toEqual({
      kind: "create",
      fileName: "003.txt",
      chapter: 3,
    });
  });

  test("1話も無ければ、第1話を作る", () => {
    expect(planLatestEpisode([], isBlankEpisode, naming, format)).toEqual({
      kind: "create",
      fileName: "001.txt",
      chapter: 1,
    });
  });

  test("桁数と拡張子は、設定に従う", () => {
    // 「新規話数ファイルを追加」と同じ決まりにする。
    // 揃えないと、同じ作品にファイル名の形が2種類できる
    const plan = planLatestEpisode(
      [episode("0001.md", 1, 100)],
      isBlankEpisode,
      { digits: 4, extension: ".md" },
      format
    );

    expect(plan).toEqual({ kind: "create", fileName: "0002.md", chapter: 2 });
  });
});

describe("白紙かの見分け", () => {
  test("空白と改行だけなら白紙", () => {
    expect(isBlankText("")).toBe(true);
    expect(isBlankText("  \n \n")).toBe(true);
    expect(isBlankText("　あ")).toBe(false);
  });

  test("走査の結果では、総文字数で見る", () => {
    // 純文字数だと、空白だけの話が白紙になり、押すたびにそこへ戻る
    expect(isBlankEpisode({ counts: { gross: 0 } })).toBe(true);
    expect(isBlankEpisode({ counts: { gross: 3 } })).toBe(false);
  });
});
