import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";
import { ChapterStore } from "../../src/core/chapterStore";
import { groupEpisodesByChapter } from "../../src/core/chapterGrouping";
import type { EpisodeFile, WorkEntry } from "../../src/models/types";
import type { CollectedEpisode } from "../../src/core/collectedFile";
import { SYNOPSIS_SCHEMA_VERSION } from "../../src/models/synopsis";
import {
  buildChapterMaterialEntries,
  buildChapterRanges,
  ChapterProposalApplier,
  describeChapterMaterial,
  describeChapterProposal,
  INSIDE_COLLECTED_REASON,
} from "../../src/features/proposeChapters";

/**
 * 章立ての提案を承認したときの書き込み（設計書6.66.4）。
 *
 * **承認した1件だけが台帳へ入る。** AIが出した提案は、作者が押すまで
 * どこにも書かれない。書き込みは `ChapterStore` だけを通し、
 * **外で台帳が変わっていれば止まる**（ハッシュ照合）。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const chaptersPath = Uri.file(
  path.join(work.folderPath, "設定", "章立て.json")
).fsPath;

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("提案の承認と台帳への書き込み", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;
  });

  function saved(): Array<{ name: string; startEpisodePath: string }> {
    const bytes = disk.get(chaptersPath);
    if (!bytes) return [];
    return (
      JSON.parse(new TextDecoder().decode(bytes)) as {
        chapters: Array<{ name: string; startEpisodePath: string }>;
      }
    ).chapters;
  }

  async function applierOf(): Promise<ChapterProposalApplier> {
    const store = new ChapterStore(work);
    return new ChapterProposalApplier(store, await store.load());
  }

  test("承認した1件だけが台帳に入る", async () => {
    const applier = await applierOf();

    expect(
      await applier.apply({
        name: "出立の章",
        startEpisodePath: "本文/001.txt",
      })
    ).toEqual({ ok: true });

    expect(saved()).toEqual([
      { name: "出立の章", startEpisodePath: "本文/001.txt" },
    ]);
  });

  test("続けて承認したものは足される（前の1件を消さない）", async () => {
    const applier = await applierOf();
    await applier.apply({ name: "出立の章", startEpisodePath: "本文/001.txt" });
    await applier.apply({ name: "王都の章", startEpisodePath: "本文/006.txt" });

    expect(saved().map((entry) => entry.name)).toEqual([
      "出立の章",
      "王都の章",
    ]);
  });

  test("既にその話から始まる章があれば、改名になる（二重に作らない）", async () => {
    disk.set(
      chaptersPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
        })
      )
    );

    const applier = await applierOf();
    expect(
      await applier.apply({
        name: "出立の章",
        startEpisodePath: "本文/001.txt",
      })
    ).toEqual({ ok: true });

    expect(saved()).toEqual([
      { name: "出立の章", startEpisodePath: "本文/001.txt" },
    ]);
  });

  test("台帳が外で変わっていたら、上書きせずに止める", async () => {
    disk.set(
      chaptersPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
        })
      )
    );
    const applier = await applierOf();

    // 提案を眺めているあいだに、別の端末（または作者の手編集）で変わった
    const outside = utf8(
      JSON.stringify({
        schemaVersion: "1",
        chapters: [{ name: "作者が手で書いた章", startEpisodePath: "本文/001.txt" }],
      })
    );
    disk.set(chaptersPath, outside);

    const result = await applier.apply({
      name: "出立の章",
      startEpisodePath: "本文/001.txt",
    });
    expect(result.ok).toBe(false);
    expect(result.reason ?? "").toContain("章");
    expect(disk.get(chaptersPath)).toEqual(outside);
  });

  test("外で変わって止まったあとは、読み直して次の承認から通る（D）", async () => {
    disk.set(
      chaptersPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
        })
      )
    );
    const applier = await applierOf();

    // 提案を眺めているあいだに、別の端末で章が1つ足された
    disk.set(
      chaptersPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          chapters: [
            { name: "第一章", startEpisodePath: "本文/001.txt" },
            { name: "別の端末で足した章", startEpisodePath: "本文/010.txt" },
          ],
        })
      )
    );

    const first = await applier.apply({
      name: "王都の章",
      startEpisodePath: "本文/006.txt",
    });
    expect(first.ok).toBe(false);
    // **読み直したことを伝える**（作者が「もう一度押せばよい」と分かる）
    expect(first.reason ?? "").toContain("もう一度");

    // **AIを呼び直させない。** 同じパネルの同じ提案が、次の承認で通る
    const second = await applier.apply({
      name: "王都の章",
      startEpisodePath: "本文/006.txt",
    });
    expect(second).toEqual({ ok: true });
    expect(saved().map((entry) => entry.name)).toEqual([
      "第一章",
      "別の端末で足した章",
      "王都の章",
    ]);
  });
});

describe("提案パネルに出す1件の文言", () => {
  test("どの話から始まるかと理由を並べる", () => {
    const lines = describeChapterProposal({
      label: "第6話",
      reason: "舞台が王都へ移る",
    });
    expect(lines[0]).toContain("第6話");
    expect(lines.join("\n")).toContain("舞台が王都へ移る");
  });

  test("既にある章と同じ開始話なら、改名だと伝える", () => {
    const lines = describeChapterProposal({
      label: "第1話",
      reason: "",
      existingName: "第一章",
    });
    expect(lines.join("\n")).toContain("第一章");
    expect(lines.join("\n")).toContain("名前");
  });

  test("理由が空なら、その行を出さない（空の行を並べない）", () => {
    const lines = describeChapterProposal({ label: "第1話", reason: "" });
    expect(lines).toHaveLength(1);
  });
});

/**
 * 実行前の確認に添える、材料の断り書き（設計書6.66.4、実機確認リスト F-66）。
 *
 * **押す前に、材料が薄いことを言う。** あらすじが1件も無ければ
 * サブタイトルだけで区切ることになり、精度は落ちる。
 * 確認の画面が出ること自体は実機に残る。
 */
describe("実行前の確認に出す材料の断り", () => {
  test("あらすじが1件も無ければ、サブタイトルだけになると言う（実機確認リスト F-66 の代わり）", () => {
    const notice = describeChapterMaterial(0, 19);

    expect(notice).toContain("各話あらすじがまだありません");
    expect(notice).toContain("サブタイトルだけを材料にする");
    expect(notice).toContain("精度は落ちます");
  });

  test("一部にしか無ければ、件数を出す（実機確認リスト F-66 の代わり）", () => {
    expect(describeChapterMaterial(7, 19)).toContain(
      "あらすじのある話は 7/19 件です"
    );
  });

  test("全部そろっていれば、何も言わない（実機確認リスト F-66 の代わり）", () => {
    // 毎回出すと読み飛ばされ、薄いときの注意まで効かなくなる
    expect(describeChapterMaterial(19, 19)).toBe("");
  });

  test("話が1つも無いときも、薄い側として扱う（実機確認リスト F-66 の代わり）", () => {
    expect(describeChapterMaterial(0, 0)).toContain("各話あらすじがまだありません");
  });
});

/**
 * 合本（1ファイルに全話）の中の話を、材料に並べる（設計書6.66.4）。
 *
 * **ファイル単位で回していたころは、219話入りの合本から1件しか
 * 材料に入らなかった**（2026-09-12）。区切りの判断はこの一覧の上でしか
 * 行えないので、材料に無い話には章の区切りを提案しようがない。
 */
describe("章立ての材料（合本は中の話を1話ずつ並べる）", () => {
  function fileOf(over: Partial<EpisodeFile> & { fileName: string }): EpisodeFile {
    return {
      filePath: path.join(work.folderPath, "本文", over.fileName),
      ext: ".txt",
      chapterStart: null,
      chapterEnd: null,
      subtitle: null,
      kind: "本編",
      isInitialName: false,
      counts: {
        gross: 0,
        net: 0,
        lines: 0,
        paragraphs: 0,
        manuscriptLines: 0,
      },
      hasMetadata: false,
      metaTitle: null,
      declaredCharCount: null,
      metaUpdatedAt: null,
      hasConflictMarkers: false,
      collectedCount: null,
      ...over,
    };
  }

  const collectedFile = fileOf({
    fileName: "全話.txt",
    chapterStart: 1,
    chapterEnd: 3,
    collectedCount: 3,
  });
  const singleFile = fileOf({
    fileName: "第4話 帰還.txt",
    chapterStart: 4,
    chapterEnd: 4,
    subtitle: "帰還",
  });

  const inner: CollectedEpisode[] = [
    { order: 1, chapter: 1, title: "転生", body: "", part: null },
    { order: 2, chapter: 2, title: "出立", body: "", part: null },
    { order: 3, chapter: 3, title: "王都", body: "", part: null },
  ];

  function build() {
    return buildChapterMaterialEntries({
      files: [
        { file: collectedFile, collected: inner },
        { file: singleFile, collected: null },
      ],
    });
  }

  test("合本3話＋単話1話で、材料は4件になる", () => {
    const { episodes } = build();
    expect(episodes.map((episode) => episode.number)).toEqual([1, 2, 3, 4]);
  });

  test("合本の各話に、作品の数え方の見出しと題が付く", () => {
    const { episodes } = build();
    expect(episodes[1]).toMatchObject({
      number: 2,
      label: "第2話",
      subtitle: "出立",
    });
    // 単話はこれまでどおりファイル名から
    expect(episodes[3]).toMatchObject({ number: 4, subtitle: "帰還" });
  });

  test("SNS記事なら、合本の中も「投稿◯」で数える", () => {
    const { episodes } = buildChapterMaterialEntries({
      files: [{ file: collectedFile, collected: inner }],
      format: "sns",
    });
    expect(episodes.map((episode) => episode.label)).toEqual([
      "投稿1",
      "投稿2",
      "投稿3",
    ]);
  });

  test("各話あらすじは、合本のファイル名と話数で引ける", () => {
    const { episodes } = buildChapterMaterialEntries({
      files: [{ file: collectedFile, collected: inner }],
      synopses: {
        schemaVersion: SYNOPSIS_SCHEMA_VERSION,
        episodes: [
          {
            chapter: 2,
            fileName: "全話.txt",
            title: "出立",
            synopsis: "主人公が旅に出る",
            sourceHash: "",
            model: null,
            promptVersion: null,
            autoGenerated: true,
            authorNotes: "",
            emotion: null,
            updatedAt: null,
          },
        ],
      },
    });
    expect(episodes[1].synopsis).toBe("主人公が旅に出る");
  });

  test("話数の読めない話は材料に入れない（存在しない番号を作らせない）", () => {
    const { episodes } = buildChapterMaterialEntries({
      files: [
        {
          file: collectedFile,
          collected: [
            { order: 1, chapter: null, title: "プロローグ", body: "", part: null },
            ...inner.slice(1),
          ],
        },
      ],
    });
    expect(episodes.map((episode) => episode.number)).toEqual([2, 3]);
  });

  test("合本を読めなかったときは、これまでどおり1ファイル＝1話に倒す", () => {
    const { episodes } = buildChapterMaterialEntries({
      files: [{ file: collectedFile, collected: null }],
    });
    expect(episodes.map((episode) => episode.number)).toEqual([1]);
  });

  test("章の始まりにできるのは、合本の先頭の話だけ", () => {
    const { startable } = build();
    expect(startable.get(1)).toBe(true);
    expect(startable.get(2)).toBe(false);
    expect(startable.get(3)).toBe(false);
    // 単話ファイルはどれも始まりにできる
    expect(startable.get(4)).toBe(true);
  });
});

/**
 * 合本の途中を章の始まりに指された提案は、**承認しても入らない**。
 *
 * 章が指せるのはファイル（`Chapter.startEpisodePath`）なので、合本の
 * 2話目を入れると「合本ごと」の意味になり、作者が指したのと違う場所に
 * 章名が付く。
 */
describe("合本の途中を境目にした提案", () => {
  test("押す前に、置けないことと次の手を伝える", () => {
    const lines = describeChapterProposal({
      label: "第137話",
      reason: "舞台が変わる",
      insideCollected: true,
    });
    expect(lines.join("\n")).toContain("合本の途中には章の区切りを置けません");
    expect(lines.join("\n")).toContain("合本を話ごとに分ける");
  });

  test("断りの文言は1か所だけが持つ（説明と適用で食い違わせない）", () => {
    expect(
      describeChapterProposal({
        label: "第137話",
        reason: "",
        insideCollected: true,
      })
    ).toContain(INSIDE_COLLECTED_REASON);
  });
});

/**
 * 章の範囲（`rangeOf` の元）に、合本の中の話が全部入る（設計書6.66.4）。
 *
 * 章名の提案は「その章に入る話」を材料にする。範囲を作る
 * `groupEpisodesByChapter` は**ファイル単位**なので、合本からは1件しか
 * 数えられない。作品まるごとが1つの合本だと、**章名をほぼ材料なしで
 * 考えることになる**ので、材料と同じ割り当てで範囲を組み直す。
 */
describe("章の範囲（合本の中の話も入る）", () => {
  function fileOf(over: Partial<EpisodeFile> & { fileName: string }): EpisodeFile {
    return {
      filePath: path.join(work.folderPath, "本文", over.fileName),
      ext: ".txt",
      chapterStart: null,
      chapterEnd: null,
      subtitle: null,
      kind: "本編",
      isInitialName: false,
      counts: {
        gross: 0,
        net: 0,
        lines: 0,
        paragraphs: 0,
        manuscriptLines: 0,
      },
      hasMetadata: false,
      metaTitle: null,
      declaredCharCount: null,
      metaUpdatedAt: null,
      hasConflictMarkers: false,
      collectedCount: null,
      ...over,
    };
  }

  const collectedFile = fileOf({
    fileName: "全話.txt",
    chapterStart: 1,
    chapterEnd: 3,
    collectedCount: 3,
  });
  const singleFile = fileOf({
    fileName: "第4話 帰還.txt",
    chapterStart: 4,
    chapterEnd: 4,
    subtitle: "帰還",
  });
  const inner: CollectedEpisode[] = [
    { order: 1, chapter: 1, title: "転生", body: "", part: null },
    { order: 2, chapter: 2, title: "出立", body: "", part: null },
    { order: 3, chapter: 3, title: "王都", body: "", part: null },
  ];

  test("合本の先頭から始まる章に、合本の3話と続く単話が全部入る", () => {
    const entries = buildChapterMaterialEntries({
      files: [
        { file: collectedFile, collected: inner },
        { file: singleFile, collected: null },
      ],
    });
    const grouping = groupEpisodesByChapter(
      [collectedFile, singleFile],
      [{ name: "第一章", startEpisodePath: "本文/全話.txt" }],
      work.folderPath
    );

    const ranges = buildChapterRanges(grouping.groups, entries);
    const range = ranges.get("本文/全話.txt");
    expect([...(range ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  test("合本が読めなかったときは、これまでどおり1ファイル＝1話", () => {
    const entries = buildChapterMaterialEntries({
      files: [
        { file: collectedFile, collected: null },
        { file: singleFile, collected: null },
      ],
    });
    const grouping = groupEpisodesByChapter(
      [collectedFile, singleFile],
      [{ name: "第一章", startEpisodePath: "本文/全話.txt" }],
      work.folderPath
    );

    const range = buildChapterRanges(grouping.groups, entries).get(
      "本文/全話.txt"
    );
    expect([...(range ?? [])].sort((a, b) => a - b)).toEqual([1, 4]);
  });
});
