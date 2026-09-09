import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, FileType, Uri, workspace } from "./support/vscodeStub";
import type { WorkEntry } from "../../src/models/types";
import {
  describeLedgerFollowSummary,
  followEpisodeLedgers,
} from "../../src/features/episodeLedgers";
import type { EpisodeRename } from "../../src/core/episodeRenumber";
import { ChapterStore } from "../../src/core/chapterStore";
import { BookStore } from "../../src/core/bookStore";
import { CharacterStore } from "../../src/core/characterStore";
import { createAbilityStore } from "../../src/core/abilityStore";
import { createForeshadowStore } from "../../src/core/foreshadowStore";
import { SynopsisStore } from "../../src/core/synopsisStore";
import { PostingStore } from "../../src/core/postingStore";
import { defaultBookConfig } from "../../src/models/book";
import { emptyCharacter } from "../../src/models/character";
import { emptyAbility } from "../../src/models/ability";
import { emptyForeshadow } from "../../src/models/foreshadow";
import { emptySynopsisSet } from "../../src/models/synopsis";

/**
 * 話数を指している台帳の追従（設計書6.67.3）。
 *
 * **原稿の付け替え自体（`applyRenumberPlan`）はここでは扱わない**
 * （`episodeRenumber.test.ts` が持つ）。ここで確かめるのは、済んだ付け替え
 * から「どの台帳を、どれだけ、どう動かすか」という後半部分だけである。
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

function episodePath(fileName: string): string {
  return diskPath("本文", fileName);
}

/** `003.txt→004.txt` のような、済んだ付け替え1件 */
function rename(fromFileName: string, toFileName: string): EpisodeRename {
  const fromNumber = parseInt(fromFileName, 10);
  const toNumber = parseInt(toFileName, 10);
  return {
    fromPath: episodePath(fromFileName),
    toPath: episodePath(toFileName),
    fromFileName,
    toFileName,
    oldNumber: fromNumber,
    newNumber: toNumber,
  };
}

describe("話数を指している台帳の追従", () => {
  const disk = new Map<string, Uint8Array>();
  const directories = new Set<string>();

  beforeEach(() => {
    disk.clear();
    directories.clear();
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        directories.add(uri.fsPath);
      },
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      // 一覧型の台帳（人物・能力・伏線）が使う。**常に成功させ、無ければ
      // 空一覧を返す**——ディレクトリを作ったかどうかで場合分けしない
      // ほうが、テストごとの下準備が少なくて済む
      readDirectory: async (uri: { fsPath: string }) => {
        return [...disk.keys()]
          .filter((filePath) => path.dirname(filePath) === uri.fsPath)
          .map(
            (filePath) =>
              [path.basename(filePath), FileType.File] as [string, FileType]
          );
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

  test("章立ての開始話が付いてくる（パスで指すもの）", async () => {
    const chapterStore = new ChapterStore(work);
    const set = await chapterStore.load();
    await chapterStore.save({
      ...set,
      chapters: [
        { name: "第一章", startEpisodePath: "本文/001.txt" },
        { name: "第二章", startEpisodePath: "本文/003.txt" },
      ],
    });

    const summary = await followEpisodeLedgers(work, [
      rename("003.txt", "004.txt"),
    ]);

    expect(summary.chapters).toBe(1);
    expect(summary.failures).toEqual([]);
    const after = await new ChapterStore(work).load();
    expect(after.chapters[0].startEpisodePath).toBe("本文/001.txt");
    expect(after.chapters[1].startEpisodePath).toBe("本文/004.txt");
  });

  test("book.json の挿絵・ページ位置が付いてくる（パスで指すもの）", async () => {
    const bookStore = new BookStore(work);
    const config = await bookStore.load();
    await bookStore.save({
      ...config,
      illustrations: [
        { episodePath: "本文/003.txt", afterParagraph: 2, imagePath: "a.png", caption: "" },
        { episodePath: "本文/001.txt", afterParagraph: 1, imagePath: "b.png", caption: "" },
      ],
      pageBreaks: [{ episodePath: "本文/003.txt", afterParagraph: 5 }],
    });

    const summary = await followEpisodeLedgers(work, [
      rename("003.txt", "004.txt"),
    ]);

    expect(summary.bookPositions).toBe(2);
    expect(summary.bookOrphaned).toBe(0);
    const after = await new BookStore(work).load();
    expect(after.illustrations[0].episodePath).toBe("本文/004.txt");
    expect(after.illustrations[1].episodePath).toBe("本文/001.txt");
    expect(after.pageBreaks[0].episodePath).toBe("本文/004.txt");
  });

  test("消えた話を指す挿絵は、消さずに孤児として数える（削除）", async () => {
    const bookStore = new BookStore(work);
    const config = await bookStore.load();
    await bookStore.save({
      ...config,
      illustrations: [
        { episodePath: "本文/003.txt", afterParagraph: 2, imagePath: "a.png", caption: "" },
      ],
    });

    const summary = await followEpisodeLedgers(
      work,
      [rename("004.txt", "003.txt")],
      {
        filePath: episodePath("003.txt"),
        number: 3,
        next: { filePath: episodePath("003.txt"), number: 3 },
      }
    );

    expect(summary.bookOrphaned).toBe(1);
    const after = await new BookStore(work).load();
    // 消えたはずの参照は消さずに残す（設計書6.67.3）
    expect(after.illustrations[0].episodePath).toBe("本文/003.txt");
  });

  test("登場人物の話数が付いてくる。動かなかった話は動かない（話数の数字で指すもの）", async () => {
    const characterStore = new CharacterStore(work);
    const person = emptyCharacter("char_001", "月島灯");
    person.appearedChapters = [1, 3, 5];
    await characterStore.save(person);

    // 第3話の前に挿入して 005→006・003→004 が済んだ（第1話は動いていない）
    const summary = await followEpisodeLedgers(work, [
      rename("005.txt", "006.txt"),
      rename("003.txt", "004.txt"),
    ]);

    expect(summary.characters).toBeGreaterThan(0);
    expect(summary.failures).toEqual([]);
    const { characters } = await new CharacterStore(work).loadAll();
    expect(characters[0].appearedChapters).toEqual([1, 4, 6]);
  });

  test("能力の話数も付いてくる（設定資料は4種とも同じ形）", async () => {
    const abilityStore = createAbilityStore(work);
    const ability = emptyAbility("abil_001", "光の刃");
    ability.appearedChapters = [2, 5];
    await abilityStore.saveAll([ability]);

    const summary = await followEpisodeLedgers(work, [
      rename("005.txt", "006.txt"),
      rename("003.txt", "004.txt"),
    ]);

    expect(summary.abilities).toBe(1);
    const { records } = await createAbilityStore(work).loadAll();
    expect(records[0].appearedChapters).toEqual([2, 6]);
  });

  test("伏線の張った話・回収した話が付いてくる", async () => {
    const foreshadowStore = createForeshadowStore(work);
    const foreshadow = emptyForeshadow("foreshadow_1", "祖父の懐中時計");
    foreshadow.plantedChapter = 2;
    foreshadow.resolvedChapter = 5;
    await foreshadowStore.saveAll([foreshadow]);

    const summary = await followEpisodeLedgers(work, [
      rename("005.txt", "006.txt"),
      rename("003.txt", "004.txt"),
    ]);

    expect(summary.foreshadows).toBe(1);
    const { records } = await createForeshadowStore(work).loadAll();
    expect(records[0].plantedChapter).toBe(2);
    expect(records[0].resolvedChapter).toBe(6);
  });

  test("各話あらすじが、話数とファイル名の両方で付いてくる", async () => {
    const synopsisStore = new SynopsisStore(work);
    await synopsisStore.save({
      ...emptySynopsisSet(),
      episodes: [
        {
          chapter: 3,
          fileName: "003.txt",
          title: null,
          synopsis: "祭りの準備をする。",
          sourceHash: "",
          model: null,
          promptVersion: null,
          autoGenerated: true,
          authorNotes: "",
          emotion: null,
          updatedAt: null,
        },
      ],
    });

    const summary = await followEpisodeLedgers(work, [
      rename("003.txt", "004.txt"),
    ]);

    expect(summary.synopses).toBeGreaterThan(0);
    const after = await new SynopsisStore(work).load();
    expect(after.episodes[0].chapter).toBe(4);
    expect(after.episodes[0].fileName).toBe("004.txt");
  });

  test("1つの台帳が外部変更で保存できなくても、ほかの台帳は続けて追従する", async () => {
    const chapterStore = new ChapterStore(work);
    const set = await chapterStore.load();
    await chapterStore.save({
      ...set,
      chapters: [{ name: "第二章", startEpisodePath: "本文/003.txt" }],
    });

    const characterStore = new CharacterStore(work);
    const person = emptyCharacter("char_001", "月島灯");
    person.appearedChapters = [3];
    await characterStore.save(person);

    // 章立て台帳だけ、**読み込みのあと・保存の直前**に外部で書き換えられた
    // 体にする。`ChapterStore` は読み込み時に1回、保存の直前にもう1回
    // 同じファイルを読んで食い違いを見る（`assertSaveAllowed`）ので、
    // 1回目はそのまま、2回目以降だけ差し替える
    const chapterPath = diskPath("設定", "章立て.json");
    const tampered = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: "0.1",
        chapters: [{ name: "作者が手で書いた章", startEpisodePath: "本文/003.txt" }],
      })
    );
    const readFile = workspace.fs.readFile;
    let chapterReads = 0;
    workspace.fs.readFile = async (uri: { fsPath: string }) => {
      if (uri.fsPath === chapterPath) {
        chapterReads++;
        if (chapterReads > 1) {
          disk.set(chapterPath, tampered);
          return tampered;
        }
      }
      return readFile(uri as never);
    };

    const summary = await followEpisodeLedgers(work, [
      rename("003.txt", "004.txt"),
    ]);

    // 章立ては失敗として報告され、原稿の付け替え（呼び出し側の仕事）は
    // ここでは巻き戻さない。**ほかの台帳（人物）は失敗の影響を受けない**
    expect(summary.failures.length).toBe(1);
    expect(summary.failures[0]).toContain("章立て");
    expect(summary.characters).toBeGreaterThan(0);

    // 章立ての中身は、作者が外で書いたものが残っている（上書きされていない）
    const chapterAfter = JSON.parse(
      new TextDecoder().decode(disk.get(diskPath("設定", "章立て.json"))!)
    ) as { chapters: Array<{ name: string }> };
    expect(chapterAfter.chapters[0].name).toBe("作者が手で書いた章");
  });

  test("何も動かないときは、報告の文章が空になる", async () => {
    const summary = await followEpisodeLedgers(work, []);
    expect(describeLedgerFollowSummary(summary)).toBe("");
  });

  test("途中で止まった付け替えでは、動いた話の話数だけが動く（A-1）", async () => {
    // 「第3話の前に挿入」で 005→006 まで済み、004→005 で止まった。
    // **算術（第3話以降を+1）で台帳を動かすと、原稿は 003・004 のままなのに
    // 台帳だけが 004・005 を指す**
    const characterStore = new CharacterStore(work);
    const person = emptyCharacter("char_001", "月島灯");
    person.appearedChapters = [3, 4, 5];
    await characterStore.save(person);

    await followEpisodeLedgers(work, [rename("005.txt", "006.txt")]);

    const { characters } = await new CharacterStore(work).loadAll();
    expect(characters[0].appearedChapters).toEqual([3, 4, 6]);
  });

  test("動かせなかった話（合本）の話数は、台帳でも動かさない（A-1）", async () => {
    // 第4話が合本で skipped になり、003→004 と 005→006 だけが済んだ
    const abilityStore = createAbilityStore(work);
    const ability = emptyAbility("abil_001", "光の刃");
    ability.appearedChapters = [3, 4, 5];
    await abilityStore.saveAll([ability]);

    await followEpisodeLedgers(work, [
      rename("005.txt", "006.txt"),
      rename("003.txt", "004.txt"),
    ]);

    const { records } = await createAbilityStore(work).loadAll();
    expect(records[0].appearedChapters).toEqual([4, 6]);
  });

  test("開始の話を消された章は、次の話へ移り、通知に出る（B-1）", async () => {
    const chapterStore = new ChapterStore(work);
    const set = await chapterStore.load();
    await chapterStore.save({
      ...set,
      chapters: [
        { name: "第一章", startEpisodePath: "本文/001.txt" },
        { name: "第二章", startEpisodePath: "本文/003.txt" },
      ],
    });

    const summary = await followEpisodeLedgers(
      work,
      [rename("004.txt", "003.txt"), rename("005.txt", "004.txt")],
      {
        filePath: episodePath("003.txt"),
        number: 3,
        next: { filePath: episodePath("003.txt"), number: 3 },
      }
    );

    expect(summary.failures).toEqual([]);
    expect(summary.chapterStartMoves).toEqual([
      { name: "第二章", toLabel: "第3話" },
    ]);
    const after = await new ChapterStore(work).load();
    expect(after.chapters.map((c) => c.startEpisodePath)).toEqual([
      "本文/001.txt",
      "本文/003.txt",
    ]);
    expect(describeLedgerFollowSummary(summary)).toContain("第二章");
  });

  test("空になった章は外れる。開始の重複で保存ごと落ちない（B-1）", async () => {
    const chapterStore = new ChapterStore(work);
    const set = await chapterStore.load();
    await chapterStore.save({
      ...set,
      chapters: [
        { name: "第二章", startEpisodePath: "本文/003.txt" },
        { name: "第三章", startEpisodePath: "本文/004.txt" },
      ],
    });

    const summary = await followEpisodeLedgers(
      work,
      [rename("004.txt", "003.txt")],
      {
        filePath: episodePath("003.txt"),
        number: 3,
        next: { filePath: episodePath("003.txt"), number: 3 },
      }
    );

    // **`duplicate_start` で章立ての保存が丸ごと落ちない**
    expect(summary.failures).toEqual([]);
    expect(summary.chapterDrops).toEqual(["第二章"]);
    const after = await new ChapterStore(work).load();
    expect(after.chapters).toEqual([
      { name: "第三章", startEpisodePath: "本文/003.txt" },
    ]);
  });

  test("設定資料は1件ずつ数える。1件書けなくても、書けたぶんは数に出る（B-2）", async () => {
    const abilityStore = createAbilityStore(work);
    const first = emptyAbility("abil_001", "光の刃");
    first.appearedChapters = [3];
    const second = emptyAbility("abil_002", "影渡り");
    second.appearedChapters = [3];
    await abilityStore.saveAll([first, second]);

    // 「影渡り」のファイルだけ書き込めない体にする
    const rename0 = workspace.fs.rename;
    workspace.fs.rename = async (
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      if (to.fsPath.includes("abil_002")) throw new Error("使用中です");
      return rename0(from as never, to as never, options as never);
    };

    const summary = await followEpisodeLedgers(work, [
      rename("003.txt", "004.txt"),
    ]);

    expect(summary.abilities).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toContain("影渡り");
  });

  test("あらすじの名前は、その話数の付け替えと名前が合う行だけ変える（B-4）", async () => {
    const synopsisStore = new SynopsisStore(work);
    const row = (chapter: number | null, fileName: string) => ({
      chapter,
      fileName,
      title: null,
      synopsis: "祭りの準備をする。",
      sourceHash: "",
      model: null,
      promptVersion: null,
      autoGenerated: true,
      authorNotes: "",
      emotion: null,
      updatedAt: null,
    });
    await synopsisStore.save({
      ...emptySynopsisSet(),
      // 第3話のあらすじが、番外編の同じ名前のファイルから作られている体
      episodes: [row(3, "003.txt"), row(4, "番外003.txt")],
    });

    await followEpisodeLedgers(work, [
      rename("004.txt", "005.txt"),
      rename("003.txt", "004.txt"),
    ]);

    const after = await new SynopsisStore(work).load();
    expect(after.episodes[0]).toMatchObject({ chapter: 4, fileName: "004.txt" });
    // 話数は付いてくるが、名前は別のファイルのものなので触らない
    expect(after.episodes[1]).toMatchObject({
      chapter: 5,
      fileName: "番外003.txt",
    });
  });

  /**
   * 投稿状態（設計書6.68.2）。**パスで話を指す**ので、章立て・挿絵と
   * 同じく付け替えで指し先を書き換える。
   */
  test("投稿状態の記録が付いてくる（パスで指すもの）", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    await store.save({
      ...ledger,
      posts: [
        {
          episodePath: "本文/003.txt",
          site: "kakuyomu",
          postedAt: "2026-09-04T00:00:00.000Z",
        },
        {
          episodePath: "本文/001.txt",
          site: "kakuyomu",
          postedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    });

    const summary = await followEpisodeLedgers(work, [
      rename("003.txt", "004.txt"),
    ]);

    expect(summary.posting).toBe(1);
    expect(summary.failures).toEqual([]);
    const after = await new PostingStore(work).load();
    expect(after.posts.map((post) => post.episodePath)).toEqual([
      "本文/004.txt",
      "本文/001.txt",
    ]);
    expect(describeLedgerFollowSummary(summary)).toContain("投稿状態1件");
  });

  /**
   * **消えた話の記録は落とす。**
   *
   * 挿絵（孤児として残す）と扱いが違う。詰めたあとの `本文/003.txt` は
   * **繰り上がってきた別の話**なので、残すと「もう投稿済み」と読まれ、
   * まだ出していない話が飛ばされる（話数を落とす `EpisodeShift.removed`
   * と同じ理由）。
   */
  test("消えた話の投稿記録は落とす（別の話が投稿済みに見えないように）", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    await store.save({
      ...ledger,
      posts: [
        {
          episodePath: "本文/003.txt",
          site: "kakuyomu",
          postedAt: "2026-09-04T00:00:00.000Z",
        },
      ],
    });

    const summary = await followEpisodeLedgers(
      work,
      [rename("004.txt", "003.txt")],
      {
        filePath: episodePath("003.txt"),
        number: 3,
        next: { filePath: episodePath("003.txt"), number: 3 },
      }
    );

    expect(summary.postingDropped).toBe(1);
    const after = await new PostingStore(work).load();
    expect(after.posts).toEqual([]);
    expect(describeLedgerFollowSummary(summary)).toContain("投稿の記録");
  });
});
