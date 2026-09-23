import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import type { Chapter } from "../../../src/models/chapter";
import {
  buildPlotEpisodeRows,
  nextPlannedEpisodeNumber,
  parsePlannedEpisodeNumber,
  plannedEpisodePlotChapters,
} from "../../../src/core/plotMode";
import {
  buildEpisodePlotTemplate,
  episodePlotTitleFromText,
} from "../../../src/core/resumeSheet";
import { parseEpisodePlot } from "../../../src/core/episodePlotDoc";
import { scanWork } from "../../../src/core/scanner";

/**
 * 予定の話（設計書6.4.8）。作者の依頼（2026-09-23）：
 * 「プロットモードで、将来書く予定の話を追加できるようにしてください」。
 *
 * **予定の話は、単話プロットのファイルだけでできている。** 単話プロットは
 * `設定/episode-plots/第N話.md` という**話数だけ**で本文と結びつくので、
 * 本文の無い話数のプロットは今でも置ける。本文のファイルは作らない。
 * 作者があとで第N話の本文を作れば、同じ話数なので何もしなくても1行に結びつく。
 */

function episode(over: Partial<EpisodeFile> & { fileName: string }): EpisodeFile {
  return {
    filePath: `C:/work/本文/${over.fileName}`,
    ext: ".txt",
    chapterStart: null,
    chapterEnd: null,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: { gross: 0, net: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
    ...over,
  } as EpisodeFile;
}

const written = (n: number, net = 1000) =>
  episode({
    fileName: `${String(n).padStart(3, "0")}.txt`,
    chapterStart: n,
    chapterEnd: n,
    counts: { gross: net, net, lines: 1, paragraphs: 1, manuscriptLines: 1 },
  });

const plan = (chapter: number, title = "") => ({
  chapter,
  title,
  filePath: `C:/work/設定/episode-plots/第${chapter}話.md`,
});

describe("予定の話の雛形（題を持てる）", () => {
  test("題を渡すと見出しに入り、読み戻せる", () => {
    const text = buildEpisodePlotTemplate(5, "決戦前夜");

    expect(text.startsWith("# 第5話「決戦前夜」の単話プロット")).toBe(true);
    expect(episodePlotTitleFromText(text)).toBe("決戦前夜");
  });

  test("題が無ければ、これまでと同じ雛形", () => {
    expect(buildEpisodePlotTemplate(5)).toBe(buildEpisodePlotTemplate(5, ""));
    expect(buildEpisodePlotTemplate(5).startsWith("# 第5話の単話プロット\n")).toBe(
      true
    );
    expect(episodePlotTitleFromText(buildEpisodePlotTemplate(5))).toBe("");
  });

  test("題の改行は1行に畳む（見出しを2行に割らない）", () => {
    const text = buildEpisodePlotTemplate(5, "  夜の\n街道  ");

    expect(text.split("\n")[0]).toBe("# 第5話「夜の 街道」の単話プロット");
  });

  test("題に鉤括弧が入っていても読み戻せる", () => {
    expect(
      episodePlotTitleFromText(buildEpisodePlotTemplate(2, "「さよなら」と言えない"))
    ).toBe("「さよなら」と言えない");
  });

  test("題に節の言葉（視点・目標・展開）が入っても、節の読み取りを乱さない", () => {
    // 見出しの題を節と取り違えると、雛形の問いかけの読み方がずれる
    const doc = parseEpisodePlot(buildEpisodePlotTemplate(3, "視点の交代と展開"));

    expect(doc.blanks).toEqual(["視点", "この話の目標", "展開（箇条書き）"]);
    expect(doc.items).toEqual([]);
  });
});

describe("予定の話数の決め方", () => {
  const episodes = [written(1), written(2), written(3)];

  test("既定は、書いた話と予定の話のうち最後の次", () => {
    expect(nextPlannedEpisodeNumber(episodes, [])).toBe(4);
    expect(nextPlannedEpisodeNumber(episodes, [4, 6])).toBe(7);
  });

  test("まだ1話も無ければ第1話から", () => {
    expect(nextPlannedEpisodeNumber([], [])).toBe(1);
  });

  test("合本は最後の話数まで埋まっているものとして数える", () => {
    const collected = episode({
      fileName: "001-010.txt",
      chapterStart: 1,
      chapterEnd: 10,
    });
    expect(nextPlannedEpisodeNumber([collected], [])).toBe(11);
  });

  test("本文のある話数には予定を足せない", () => {
    const result = parsePlannedEpisodeNumber("2", episodes, []);
    expect(result.chapter).toBeUndefined();
    expect(result.problem).toContain("本文があります");
  });

  test("合本の途中の話数にも足せない（その話の本文がある）", () => {
    const collected = episode({
      fileName: "001-010.txt",
      chapterStart: 1,
      chapterEnd: 10,
    });
    expect(parsePlannedEpisodeNumber("5", [collected], []).problem).toContain(
      "本文があります"
    );
  });

  test("単話プロットが既にある話数には足せない（上書きしない）", () => {
    expect(parsePlannedEpisodeNumber("6", episodes, [6]).problem).toContain(
      "既にあります"
    );
  });

  test("数字でなければ訊き返す。全角の数字は読む", () => {
    expect(parsePlannedEpisodeNumber("次", episodes, []).problem).toBeTruthy();
    expect(parsePlannedEpisodeNumber("0", episodes, []).problem).toBeTruthy();
    expect(parsePlannedEpisodeNumber("", episodes, []).problem).toBeTruthy();
    expect(parsePlannedEpisodeNumber("５", episodes, [])).toEqual({ chapter: 5 });
    expect(parsePlannedEpisodeNumber(" 第8話 ", episodes, [])).toEqual({
      chapter: 8,
    });
  });

  test("書いた話のあいだの空いた話数には足せる", () => {
    expect(
      parsePlannedEpisodeNumber("4", [written(1), written(5)], [])
    ).toEqual({ chapter: 4 });
  });
});

describe("予定の話はどれか", () => {
  test("本文の無い話数の単話プロットだけが予定", () => {
    expect(
      plannedEpisodePlotChapters([written(1), written(2)], [1, 3, 5])
    ).toEqual([3, 5]);
  });

  test("合本の途中の話数のプロットは予定にしない（本文はある）", () => {
    const collected = episode({
      fileName: "001-003.txt",
      chapterStart: 1,
      chapterEnd: 3,
    });
    expect(plannedEpisodePlotChapters([collected], [2, 4])).toEqual([4]);
  });
});

describe("見取り図に予定の話を並べる", () => {
  function rowsOf(
    episodes: EpisodeFile[],
    planned: ReturnType<typeof plan>[],
    chapters: Chapter[] = []
  ) {
    return buildPlotEpisodeRows({
      episodes,
      chapters,
      workFolder: "C:/work",
      synopses: [],
      episodePlotChapters: new Set(planned.map((entry) => entry.chapter)),
      plannedEpisodes: planned,
    });
  }

  test("書いた話のあとに、話数の順で並ぶ", () => {
    const rows = rowsOf([written(1), written(2)], [plan(5), plan(3, "嵐の夜")]);

    expect(rows.map((row) => [row.label, row.planned])).toEqual([
      ["第1話", false],
      ["第2話", false],
      ["第3話", true],
      ["第5話", true],
    ]);
    expect(rows[2].title).toBe("嵐の夜");
  });

  test("空いた話数の予定は、その位置へ入る", () => {
    const rows = rowsOf([written(1), written(4)], [plan(2)]);

    expect(rows.map((row) => row.label)).toEqual(["第1話", "第2話", "第4話"]);
  });

  test("話数の読めない話（あとがき等）より前、最後の番号つきの話のあとへ置く", () => {
    const afterword = episode({ fileName: "あとがき.txt" });
    const rows = rowsOf([written(1), afterword], [plan(2)]);

    expect(rows.map((row) => row.label)).toEqual([
      "第1話",
      "第2話",
      "あとがき.txt",
    ]);
  });

  test("予定の話は、本文なし・字数0・単話プロットあり", () => {
    const [row] = rowsOf([], [plan(1, "はじまり")]);

    expect(row.planned).toBe(true);
    expect(row.hasManuscript).toBe(false);
    expect(row.net).toBe(0);
    expect(row.gross).toBe(0);
    expect(row.hasEpisodePlot).toBe(true);
    expect(row.chapter).toBe(1);
    // 押すと単話プロットが開く（行の場所はプロットのファイル）
    expect(row.filePath).toBe("C:/work/設定/episode-plots/第1話.md");
    // 本文が無いので、掛けられるのは設計の検査だけ
    expect(row.episodePlotChecks).toEqual(["design"]);
  });

  test("本文ができたら、同じ話として1行に結びつく（予定の印が外れる）", () => {
    // 作者が第3話の本文を書き始めた（新しい話を作る既存の道で 003.txt ができた）
    const rows = rowsOf([written(1), written(2), written(3)], [plan(3, "嵐の夜")]);

    expect(rows).toHaveLength(3);
    expect(rows[2].planned).toBe(false);
    expect(rows[2].fileName).toBe("003.txt");
    expect(rows[2].hasEpisodePlot).toBe(true);
  });

  test("書いた話の行には予定の印が付かない", () => {
    const rows = rowsOf([written(1)], []);
    expect(rows[0].planned).toBe(false);
  });

  test("同じ章の話のあいだに入った予定は、その章の名前を受け継ぐ", () => {
    const chapters: Chapter[] = [
      { name: "第一章", startEpisodePath: "本文/001.txt" },
    ];
    const rows = rowsOf([written(1), written(3)], [plan(2)], chapters);

    expect(rows.map((row) => row.chapterName)).toEqual([
      "第一章",
      "第一章",
      "第一章",
    ]);
  });

  test("最後の話のあとの予定には、章の名前を捏造しない", () => {
    const chapters: Chapter[] = [
      { name: "第一章", startEpisodePath: "本文/001.txt" },
    ];
    const rows = rowsOf([written(1)], [plan(2)], chapters);

    expect(rows[1].chapterName).toBe("");
  });
});

describe("予定の話は数えない", () => {
  const work: WorkEntry = {
    id: "work_test",
    title: "作品",
    folderPath: "C:\\novels\\work",
    registeredAt: "2026-08-06T00:00:00.000Z",
  };

  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  test("単話プロットの置き場は、走査（話数・字数・執筆量・投稿の元）に入らない", async () => {
    /*
      執筆量・字数・話の一覧・投稿は、どれも走査（`scanWork`）の結果から
      数える。予定の話は `設定/episode-plots/第N話.md` にしか無いので、
      走査が `設定` を歩かない限り数に入らない。その前提をここで押さえる。
    */
    const readDirectory = vi.fn(async (uri: { fsPath: string }) => {
      if (uri.fsPath.endsWith("設定")) {
        return [["episode-plots", FileType.Directory]];
      }
      if (uri.fsPath.endsWith("episode-plots")) {
        return [["第2話.md", FileType.File]];
      }
      return [
        ["001.txt", FileType.File],
        ["設定", FileType.Directory],
      ];
    });
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        if (uri.fsPath.endsWith(".json")) {
          throw new FileSystemError("設定なし", "FileNotFound");
        }
        return new TextEncoder().encode("灯が歩いた。");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory,
    };

    const result = await scanWork(work);

    expect(result.episodes.map((entry) => entry.fileName)).toEqual(["001.txt"]);
  });
});
