import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import type { WorkEntry } from "../../../src/models/types";
import {
  followExplorerRenames,
  RenameDriftChecker,
} from "../../../src/features/episodeRenameWatch";
import { ChapterStore } from "../../../src/core/chapterStore";
import { PostingStore } from "../../../src/core/postingStore";
import { TimelineStore } from "../../../src/core/timelineStore";
import { isPosted } from "../../../src/models/posting";
import { postingTextHash } from "../../../src/core/postingBodyHash";
import { findWorkForFile } from "../../../src/core/workRegistry";

/**
 * 製品の外で話の名前を変えたとき、パスで話を指す台帳を付け替える
 * （設計書6.68.2。作者の決定 2026-11-04）。
 *
 * - VS Code のエクスプローラーでの改名（`onDidRenameFiles`）：黙って付け替え、件数を知らせる
 * - OS・git pull での改名：次に作品を開いたときに「この話ですか」と訊いてから付け替える
 *
 * 0.125.4 では製品の中の3つの改名だけを追い、ここは追っていなかった（投稿済みの話が
 * 「未投稿」に見える）。先にこのテストを書き、落ちることを確かめてから実装した。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-03T00:00:00.000Z",
};

function diskPath(...parts: string[]): string {
  return Uri.file(path.join(work.folderPath, ...parts)).fsPath;
}

const encoder = new TextEncoder();
// 製品と同じ引き方（`extension.ts` の `findWorkForPath` の中身）
const lookup = (filePath: string): WorkEntry | undefined => findWorkForFile([work], filePath);

async function seedLedgers(
  relPath: string,
  extra: { bodyHash?: string } = {}
): Promise<void> {
  const posting = new PostingStore(work);
  const ledger = await posting.load();
  await posting.save({
    ...ledger,
    posts: [
      {
        episodePath: relPath,
        site: "kakuyomu",
        postedAt: "2026-11-01T00:00:00.000Z",
        siteEpisodeId: "16818000000000000",
        ...(extra.bodyHash ? { bodyHash: extra.bodyHash } : {}),
      },
    ],
  });
  const chapters = new ChapterStore(work);
  const set = await chapters.load();
  await chapters.save({ ...set, chapters: [{ name: "第一章", startEpisodePath: relPath }] });
  const timeline = new TimelineStore(work);
  const loaded = await timeline.load();
  await timeline.save({
    ...loaded,
    lines: [
      { id: "ln_001", label: "本編", kind: "main", canonical: true, branchFrom: null, note: "" },
    ],
    timepoints: [{ id: "tp_001", lineId: "ln_001", label: "十年前", absolute: null, note: "" }],
    episodes: [{ filePath: relPath, timepointId: "tp_001", note: "" }],
  });
}

async function postingPaths(): Promise<string[]> {
  return (await new PostingStore(work).load()).posts.map((post) => post.episodePath);
}

/** この機械の保管（globalState）の代役 */
function memento(): {
  values: Map<string, unknown>;
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Promise<void>;
} {
  const values = new Map<string, unknown>();
  return {
    values,
    get<T>(key: string, fallback: T): T {
      return values.has(key) ? (values.get(key) as T) : fallback;
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
}

describe("エクスプローラーで名前を変えたとき", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk, {
      methods: ["createDirectory", "readFile", "writeFile", "rename", "delete", "stat", "readDirectory"],
      readDirectory: "filesOnly",
    });
  });

  test("話のファイルなら、訊かずに4つの台帳を付け替えて件数を知らせる", async () => {
    await seedLedgers("本文/003.txt");
    disk.set(diskPath("本文", "003_湖畔の誓い.txt"), encoder.encode("本文です。"));

    const outcomes = await followExplorerRenames(
      [{ fromPath: diskPath("本文", "003.txt"), toPath: diskPath("本文", "003_湖畔の誓い.txt") }],
      lookup
    );

    const ledger = await new PostingStore(work).load();
    expect(isPosted(ledger, "本文/003_湖畔の誓い.txt", "kakuyomu")).toBe(true);
    expect((await new ChapterStore(work).load()).chapters[0].startEpisodePath).toBe(
      "本文/003_湖畔の誓い.txt"
    );
    expect((await new TimelineStore(work).load()).episodes[0].filePath).toBe(
      "本文/003_湖畔の誓い.txt"
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].notice?.warn).toBe(false);
    expect(outcomes[0].notice?.text).toContain("003.txt を 003_湖畔の誓い.txt に変えたのに合わせて");
    expect(outcomes[0].notice?.text).toContain("投稿状態1件");
  });

  test("同じ改名が2回来ても、2回目は0件で何も知らせない", async () => {
    await seedLedgers("本文/003.txt");
    const rename = [
      { fromPath: diskPath("本文", "003.txt"), toPath: diskPath("本文", "003_湖畔の誓い.txt") },
    ];
    const first = await followExplorerRenames(rename, lookup);
    const second = await followExplorerRenames(rename, lookup);

    expect(first[0].notice).toBeDefined();
    expect(second.every((outcome) => outcome.notice === undefined)).toBe(true);
    expect(second[0]?.summary.posting ?? 0).toBe(0);
    expect(await postingPaths()).toEqual(["本文/003_湖畔の誓い.txt"]);
  });

  test("話の本文でないファイル（単話プロット）の改名は無視する", async () => {
    await seedLedgers("本文/003.txt");
    const outcomes = await followExplorerRenames(
      [
        {
          fromPath: diskPath("設定", "episode-plots", "003.md"),
          toPath: diskPath("設定", "episode-plots", "004.md"),
        },
      ],
      lookup
    );
    expect(outcomes.every((outcome) => outcome.notice === undefined)).toBe(true);
    expect(await postingPaths()).toEqual(["本文/003.txt"]);
  });

  test("章フォルダーの改名は、中の話ごとに付け替える", async () => {
    await seedLedgers("本文/第一章/003.txt");
    const outcomes = await followExplorerRenames(
      [{ fromPath: diskPath("本文", "第一章"), toPath: diskPath("本文", "第一章 旅立ち") }],
      lookup
    );
    expect(await postingPaths()).toEqual(["本文/第一章 旅立ち/003.txt"]);
    expect(outcomes[0].notice?.text).toContain("投稿状態1件");
  });

  test("作品フォルダーそのものの改名では何もしない（相対パスは変わらない）", async () => {
    await seedLedgers("本文/003.txt");
    const outcomes = await followExplorerRenames(
      [{ fromPath: work.folderPath, toPath: `${work.folderPath}2` }],
      lookup
    );
    expect(outcomes).toEqual([]);
    expect(await postingPaths()).toEqual(["本文/003.txt"]);
  });

  test("本文フォルダーそのものの改名では何もしない（作品設定が旧名を指したままになる）", async () => {
    await seedLedgers("本文/003.txt");
    const outcomes = await followExplorerRenames(
      [{ fromPath: diskPath("本文"), toPath: diskPath("原稿") }],
      lookup
    );
    expect(outcomes.every((outcome) => outcome.notice === undefined)).toBe(true);
    expect(await postingPaths()).toEqual(["本文/003.txt"]);
  });

  test("登録した作品の外のファイルには触らない", async () => {
    const outcomes = await followExplorerRenames(
      [{ fromPath: "C:\\elsewhere\\003.txt", toPath: "C:\\elsewhere\\004.txt" }],
      lookup
    );
    expect(outcomes).toEqual([]);
  });
});

describe("OS や git pull で名前が変わったとき（次に作品を開いたときに訊く）", () => {
  const disk = new Map<string, Uint8Array>();
  const originalInfo = window.showInformationMessage;
  const originalWarning = window.showWarningMessage;
  let asked: string[];

  beforeEach(() => {
    disk.clear();
    asked = [];
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk, {
      methods: ["createDirectory", "readFile", "writeFile", "rename", "delete", "stat", "readDirectory"],
      readDirectory: "filesOnly",
    });
    window.showInformationMessage = originalInfo;
    window.showWarningMessage = originalWarning;
  });

  function answer(picked: string | undefined): void {
    window.showInformationMessage = (async (text: string) => {
      asked.push(text);
      return picked;
    }) as typeof window.showInformationMessage;
  }

  function checker(
    store: ReturnType<typeof memento>,
    current: string[]
  ): RenameDriftChecker {
    return new RenameDriftChecker({
      memento: store,
      listEpisodePaths: async () => current.map((rel) => diskPath(...rel.split("/"))),
    });
  }

  test("候補が1つなら訊き、［付け替える］で付け替える", async () => {
    await seedLedgers("本文/003.txt");
    disk.set(diskPath("本文", "003_湖畔の誓い.txt"), encoder.encode("本文です。"));
    answer("付け替える");

    await checker(memento(), ["本文/003_湖畔の誓い.txt"]).checkOnOpen(work);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("名前が変わった話が1つあります");
    expect(asked[0]).toContain("第3話「003.txt」→「003_湖畔の誓い.txt」");
    expect(await postingPaths()).toEqual(["本文/003_湖畔の誓い.txt"]);
    expect((await new ChapterStore(work).load()).chapters[0].startEpisodePath).toBe(
      "本文/003_湖畔の誓い.txt"
    );
  });

  test("1つの窓では同じ作品に2度訊かない", async () => {
    await seedLedgers("本文/003.txt");
    answer(undefined);
    const once = checker(memento(), ["本文/003_湖畔の誓い.txt"]);
    await once.checkOnOpen(work);
    await once.checkOnOpen(work);
    expect(asked).toHaveLength(1);
  });

  test("［付け替えない］を選んだら、同じ組では次の窓でも訊かない。組が変われば訊く", async () => {
    await seedLedgers("本文/003.txt");
    const store = memento();
    answer("付け替えない");
    await checker(store, ["本文/003_湖畔の誓い.txt"]).checkOnOpen(work);
    expect(asked).toHaveLength(1);
    expect(await postingPaths()).toEqual(["本文/003.txt"]);

    // 次の窓（新しい起動）。同じ組なので訊かない
    await checker(store, ["本文/003_湖畔の誓い.txt"]).checkOnOpen(work);
    expect(asked).toHaveLength(1);

    // 名前がさらに変わった（組が変わった）ので訊く
    await checker(store, ["本文/003_湖のほとり.txt"]).checkOnOpen(work);
    expect(asked).toHaveLength(2);
  });

  test("閉じただけ（答えなし）なら覚えない。次の窓でまた訊く", async () => {
    await seedLedgers("本文/003.txt");
    const store = memento();
    answer(undefined);
    await checker(store, ["本文/003_湖畔の誓い.txt"]).checkOnOpen(work);
    await checker(store, ["本文/003_湖畔の誓い.txt"]).checkOnOpen(work);
    expect(asked).toHaveLength(2);
    expect(await postingPaths()).toEqual(["本文/003.txt"]);
  });

  test("候補が無ければ訊かず、台帳も触らない", async () => {
    await seedLedgers("本文/003.txt");
    answer("付け替える");
    await checker(memento(), ["本文/001.txt", "本文/004.txt"]).checkOnOpen(work);
    expect(asked).toEqual([]);
    expect(await postingPaths()).toEqual(["本文/003.txt"]);
  });

  test("候補が複数なら訊かない", async () => {
    await seedLedgers("本文/003.txt");
    disk.set(diskPath("本文", "003_案A.txt"), encoder.encode("案Aの本文。"));
    disk.set(diskPath("本文", "003_案B.txt"), encoder.encode("案Bの本文。"));
    answer("付け替える");
    await checker(memento(), ["本文/003_案A.txt", "本文/003_案B.txt"]).checkOnOpen(work);
    expect(asked).toEqual([]);
  });

  test("候補が複数でも、投稿したときの本文の印が1つにだけ合えば訊く", async () => {
    // 投稿したときの題（旧名から読んだ題＝無し）と本文の印
    await seedLedgers("本文/003.txt", { bodyHash: postingTextHash(null, "案Bの本文。") });
    disk.set(diskPath("本文", "003_案A.txt"), encoder.encode("案Aの本文。"));
    disk.set(diskPath("本文", "003_案B.txt"), encoder.encode("案Bの本文。"));
    answer("付け替える");
    await checker(memento(), ["本文/003_案A.txt", "本文/003_案B.txt"]).checkOnOpen(work);
    expect(asked).toHaveLength(1);
    expect(await postingPaths()).toEqual(["本文/003_案B.txt"]);
  });

  test("話の本文を開いたときに訊く。単話プロットを開いただけでは訊かない", async () => {
    await seedLedgers("本文/003.txt");
    answer(undefined);
    const once = checker(memento(), ["本文/003_湖畔の誓い.txt"]);
    await once.checkOnEpisodeOpened(diskPath("設定", "episode-plots", "003.md"), lookup);
    expect(asked).toEqual([]);
    await once.checkOnEpisodeOpened(diskPath("本文", "003_湖畔の誓い.txt"), lookup);
    expect(asked).toHaveLength(1);
    // 同じ窓で別の話を開いても、もう訊かない
    await once.checkOnEpisodeOpened(diskPath("本文", "001.txt"), lookup);
    expect(asked).toHaveLength(1);
  });

  test("食い違いが無ければ何も訊かない", async () => {
    await seedLedgers("本文/003.txt");
    answer("付け替える");
    await checker(memento(), ["本文/003.txt"]).checkOnOpen(work);
    expect(asked).toEqual([]);
  });
});
