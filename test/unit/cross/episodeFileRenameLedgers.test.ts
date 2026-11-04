import * as path from "path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { renameWithSubtitle } from "../../../src/features/episodeCopy";
import { convertOne } from "../../../src/features/markdownConvert";
import { setEpisodeRenameWorkLookup } from "../../../src/features/episodeLedgers";
import { ChapterStore } from "../../../src/core/chapterStore";
import { PostingStore } from "../../../src/core/postingStore";
import { TimelineStore } from "../../../src/core/timelineStore";
import { isPosted } from "../../../src/models/posting";

/**
 * 製品の中で話の**名前だけ**を変えたとき、パスで話を指す台帳がついてくる
 * （設計書6.68.2・6.67.3。2026-11-04 ノートPCの懸念から調べた）。
 *
 * ## 何が起きていたか
 *
 * 話数の付け替え（挿入・削除）は `followEpisodeLedgers` で台帳を付け替えるのに、
 * **名前だけを変える道は台帳に触れていなかった**：
 *
 * - 右クリック「ファイル名にサブタイトルを付ける」（`renameWithSubtitle`）
 * - 各話あらすじのあとのサブタイトル案の採用（`renameEpisodeFile`）
 * - 本文の .md 化（`renamePreservingContent`。拡張子が変わるので相対パスも変わる）
 *
 * 投稿状態の台帳は相対パスで話を引く（`postingEpisodeKey`）ので、名前を変えた話は
 * **「未投稿」に見え**、出し直しの促し・題の貼り替えの案内・サイトの話の番号が
 * 届かなくなる。同じ話を新しい話としてもう一度出してしまうおそれがある。
 * 章立ての開始の話・年表の指し先も同じ形で外れる。
 *
 * 1・2つめを先に書いて落ちることを確かめてから直した（再現テスト）。
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

function episodeFile(fileName: string): EpisodeFile {
  return {
    filePath: diskPath("本文", fileName),
    fileName,
    ext: path.extname(fileName),
    chapterStart: 3,
    chapterEnd: 3,
    subtitle: null,
    kind: "episode",
    isInitialName: true,
    counts: { total: 0, withoutSpaces: 0, withoutBlankLines: 0 },
    hasMetadata: true,
    metaTitle: "湖畔の誓い",
    declaredCharCount: null,
    metaUpdatedAt: null,
  } as unknown as EpisodeFile;
}

const encoder = new TextEncoder();

async function seedLedgers(relPath: string): Promise<void> {
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
      },
    ],
  });
  const chapters = new ChapterStore(work);
  const set = await chapters.load();
  await chapters.save({
    ...set,
    chapters: [{ name: "第一章", startEpisodePath: relPath }],
  });
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

describe("名前だけを変えたとき、パスで話を指す台帳がついてくる", () => {
  const disk = new Map<string, Uint8Array>();
  const originalWarning = window.showWarningMessage;

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk, {
      methods: ["createDirectory", "readFile", "writeFile", "rename", "delete", "stat", "readDirectory"],
      readDirectory: "filesOnly",
    });
    window.showWarningMessage = originalWarning;
    setEpisodeRenameWorkLookup(undefined);
  });

  test("右クリックでサブタイトルを付けても、投稿済みのまま・章立てと年表も外れない", async () => {
    disk.set(
      diskPath("本文", "003.txt"),
      encoder.encode("【タイトル】\n湖畔の誓い\n\n【本文（1行）】\n本文です。")
    );
    await seedLedgers("本文/003.txt");
    // 確認の窓で「変える」を押した
    window.showWarningMessage = (async () => "変える") as typeof window.showWarningMessage;

    await renameWithSubtitle(work, episodeFile("003.txt"));

    expect(disk.has(diskPath("本文", "003_湖畔の誓い.txt"))).toBe(true);
    const ledger = await new PostingStore(work).load();
    expect(isPosted(ledger, "本文/003_湖畔の誓い.txt", "kakuyomu")).toBe(true);
    // サイトの話の番号も記録ごと付いてくる（出し直しで編集画面を直に開くのに要る）
    expect(ledger.posts[0].siteEpisodeId).toBe("16818000000000000");
    const chapters = await new ChapterStore(work).load();
    expect(chapters.chapters[0].startEpisodePath).toBe("本文/003_湖畔の誓い.txt");
    const timeline = await new TimelineStore(work).load();
    expect(timeline.episodes[0].filePath).toBe("本文/003_湖畔の誓い.txt");
  });

  test("題が中の【タイトル】にだけある話（一覧の題が【タイトル】で埋まっている）にも、サブタイトルを付けられる", async () => {
    // 走査（scanner.ts）はファイル名に題が無いと `subtitle` を【タイトル】で埋める。
    // それを「いまファイル名に付いている題」と取り違え、「既にサブタイトルが付いています」で
    // 止まっていた（2026-11-04 画面テストで見つかった）
    disk.set(
      diskPath("本文", "003.txt"),
      encoder.encode("【タイトル】\n湖畔の誓い\n\n【本文（1行）】\n本文です。")
    );
    window.showWarningMessage = (async () => "変える") as typeof window.showWarningMessage;

    await renameWithSubtitle(work, { ...episodeFile("003.txt"), subtitle: "湖畔の誓い" });

    expect(disk.has(diskPath("本文", "003_湖畔の誓い.txt"))).toBe(true);
  });

  test(".md 化しても投稿済みのまま（拡張子が変わると相対パスも変わる）", async () => {
    disk.set(diskPath("本文", "003.txt"), encoder.encode("本文です。"));
    await seedLedgers("本文/003.txt");
    // 本文の .md 化は作品を受け取らない入口（原稿エディター・ルビ）からも呼ばれる
    setEpisodeRenameWorkLookup(() => work);

    const converted = await convertOne(diskPath("本文", "003.txt"));

    expect(converted).toBe(diskPath("本文", "003.md"));
    const ledger = await new PostingStore(work).load();
    expect(isPosted(ledger, "本文/003.md", "kakuyomu")).toBe(true);
    expect(isPosted(ledger, "本文/003.txt", "kakuyomu")).toBe(false);
    const chapters = await new ChapterStore(work).load();
    expect(chapters.chapters[0].startEpisodePath).toBe("本文/003.md");
  });

  test("サブタイトル案の採用（各話あらすじのあと）も、名前を変えたあと台帳を付け替える", () => {
    // 案を選ぶ画面が並ぶ私的な関数なので、配線をソースの形で押さえる
    const source = readFileSync(
      resolve(__dirname, "../../../src/features/generateSynopses.ts"),
      "utf8"
    );
    const rename = source.indexOf("await renameEpisodeFile(");
    const follow = source.indexOf("await followEpisodeFileRenames(work, [");
    expect(rename).toBeGreaterThan(0);
    expect(follow).toBeGreaterThan(rename);
  });

  test("登録した作品の外のファイルを .md にしても、台帳を探しに行かない", async () => {
    disk.set(diskPath("本文", "003.txt"), encoder.encode("本文です。"));
    await seedLedgers("本文/003.txt");
    setEpisodeRenameWorkLookup(() => undefined);

    await convertOne(diskPath("本文", "003.txt"));

    const ledger = await new PostingStore(work).load();
    expect(ledger.posts[0].episodePath).toBe("本文/003.txt");
  });
});
