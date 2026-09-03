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

    const summary = await followEpisodeLedgers(work, [rename("003.txt", "004.txt")], {
      pivot: 3,
      delta: 1,
    });

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

    const summary = await followEpisodeLedgers(work, [rename("003.txt", "004.txt")], {
      pivot: 3,
      delta: 1,
    });

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
      { pivot: 3, delta: -1, removed: 3 },
      episodePath("003.txt")
    );

    expect(summary.bookOrphaned).toBe(1);
    const after = await new BookStore(work).load();
    // 消えたはずの参照は消さずに残す（設計書6.67.3）
    expect(after.illustrations[0].episodePath).toBe("本文/003.txt");
  });

  test("登場人物の話数が付いてくる。挿入位置より前は動かない（話数の数字で指すもの）", async () => {
    const characterStore = new CharacterStore(work);
    const person = emptyCharacter("char_001", "月島灯");
    person.appearedChapters = [1, 3, 5];
    await characterStore.save(person);

    const summary = await followEpisodeLedgers(work, [rename("003.txt", "004.txt")], {
      pivot: 3,
      delta: 1,
    });

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

    const summary = await followEpisodeLedgers(work, [rename("003.txt", "004.txt")], {
      pivot: 3,
      delta: 1,
    });

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

    const summary = await followEpisodeLedgers(work, [rename("003.txt", "004.txt")], {
      pivot: 3,
      delta: 1,
    });

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

    const summary = await followEpisodeLedgers(work, [rename("003.txt", "004.txt")], {
      pivot: 3,
      delta: 1,
    });

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

    const summary = await followEpisodeLedgers(work, [rename("003.txt", "004.txt")], {
      pivot: 3,
      delta: 1,
    });

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
    const summary = await followEpisodeLedgers(work, [], { pivot: 99, delta: 1 });
    expect(describeLedgerFollowSummary(summary)).toBe("");
  });
});
