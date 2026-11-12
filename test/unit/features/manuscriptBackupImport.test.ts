import * as path from "path";
import { zipSync } from "fflate";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, FileType, Uri, window, workspace } from "../support/vscodeStub";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { emptyCounts } from "../../../src/core/charCount";
import { importBackupIntoWork } from "../../../src/features/manuscriptBackupImport";
import { cancelRunningTask } from "../../../src/views/progress";

/** ブラウザ版のふり（外部プロセスを起動できない） */
const runtime = vi.hoisted(() => ({ processes: true }));
vi.mock("../../../src/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/runtime")>();
  return { ...actual, canRunProcesses: () => runtime.processes };
});

/**
 * 原稿エディターの［入力］→「バックアップから」（0.150.0。設計書6.25.13）。
 * 窓・読み・書きの道を、メモリ上のファイル置き場で通す（`manuscriptImport.test.ts` と同じ作り）。
 * 判断の部分（並べ方・何を訊くか）は `test/unit/core/episodeBackupImport.test.ts`。
 *
 * **Git系は範囲外**。作品フォルダは実在しないので、番号ずらしのあとの
 * 「名前だけのコミット」の確認は出ない。
 */

const work: WorkEntry = {
  id: "work_backup_import",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "backup-import"),
  registeredAt: "2026-11-12T00:00:00.000Z",
};
const manuscriptDir = Uri.file(path.join(work.folderPath, "本文")).fsPath;
const zipPath = Uri.file(path.join("C:", "外", "星の街.zip")).fsPath;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function diskPath(fileName: string): string {
  return Uri.file(path.join(manuscriptDir, fileName)).fsPath;
}

function episode(fileName: string): EpisodeFile {
  const numberMatch = /^(\d+)/.exec(fileName);
  const chapter = numberMatch ? parseInt(numberMatch[1], 10) : null;
  return {
    filePath: diskPath(fileName),
    fileName,
    ext: ".txt",
    chapterStart: chapter,
    chapterEnd: chapter,
    subtitle: null,
    kind: "本編",
    isInitialName: true,
    counts: emptyCounts(),
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

const FIVE = ["001.txt", "002.txt", "003.txt", "004.txt", "005.txt"];

function scanOf(names: readonly string[] = FIVE) {
  return { episodes: names.map((name) => episode(name)), manuscriptDir };
}

const ABOUT = ["【タイトル】", "星の街", "", "【紹介文】", "街の話。", ""].join("\n");
const kakuyomuEpisode = (title: string, body: string) =>
  encoder.encode(["【タイトル】", title, "", "【本文】", body, ""].join("\n"));

/** カクヨムの形のバックアップ（話ごとのファイル）。3話 */
const ZIP = zipSync({
  "about.txt": encoder.encode(ABOUT),
  "episode_0001.txt": kakuyomuEpisode("第1話　転生前夜", "　夜が更けていく。"),
  "episode_0002.txt": kakuyomuEpisode("第2話　朝", "　朝が来た。｜漢字《かんじ》"),
  "episode_0003.txt": kakuyomuEpisode("第3話　昼", "　昼になった。"),
});

interface Asked {
  message: string;
  detail: string;
  titles: string[];
}

describe("原稿エディターのバックアップからの取り込み", () => {
  const disk = new Map<string, Uint8Array>();
  let asked: Asked[];
  let errors: string[];
  let warnings: string[];
  let infos: string[];
  let press: string | undefined;
  /** 選ぶ一覧で外す話の見出し */
  let unpick: string[];
  /** 選ぶ一覧に並んだもの */
  let listed: Array<{ label: string; picked?: boolean }>;
  let failRenameFrom: string | undefined;
  /** この名前の話が置かれたら、中止ボタンを押す */
  let cancelAfterPlaced: string | undefined;

  const read = (fileName: string) => decoder.decode(disk.get(diskPath(fileName)));
  const manuscriptNames = () =>
    [...disk.keys()]
      .filter((key) => path.dirname(key) === manuscriptDir)
      .map((key) => path.basename(key))
      .sort();

  beforeEach(() => {
    disk.clear();
    asked = [];
    errors = [];
    warnings = [];
    infos = [];
    press = undefined;
    unpick = [];
    listed = [];
    failRenameFrom = undefined;
    cancelAfterPlaced = undefined;
    runtime.processes = true;
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      readDirectory: async (uri: { fsPath: string }) =>
        [...disk.keys()]
          .filter((filePath) => path.dirname(filePath) === uri.fsPath)
          .map((filePath) => [path.basename(filePath), FileType.File] as [string, FileType]),
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        if (failRenameFrom && path.basename(from.fsPath) === failRenameFrom) {
          throw new Error("ほかのアプリが開いています");
        }
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
        if (cancelAfterPlaced && path.basename(to.fsPath) === cancelAfterPlaced) {
          await cancelRunningTask();
        }
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;

    for (const name of FIVE) disk.set(diskPath(name), encoder.encode(`第${name}の本文。\n`));
    disk.set(zipPath, ZIP);

    window.showOpenDialog = async () => [Uri.file(zipPath)];
    window.showQuickPick = (async (items: Array<{ label: string; picked?: boolean }>) => {
      listed = items;
      return items.filter((item) => !unpick.includes(item.label));
    }) as unknown as typeof window.showQuickPick;
    window.showWarningMessage = (async (
      message: string,
      options?: { detail?: string } | { title: string },
      ...items: Array<{ title: string } | string>
    ) => {
      const buttons = [
        ...(options && "title" in options ? [options] : []),
        ...items,
      ].filter((item): item is { title: string } => typeof item === "object");
      if (options && "detail" in options) {
        asked.push({ message, detail: options.detail ?? "", titles: buttons.map((b) => b.title) });
        return buttons.find((button) => button.title === press);
      }
      warnings.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;
    window.showErrorMessage = (async (message: string) => {
      errors.push(message);
      return undefined;
    }) as typeof window.showErrorMessage;
    window.showInformationMessage = (async (message: string) => {
      infos.push(message);
      return undefined;
    }) as typeof window.showInformationMessage;
  });

  function importInto(fileName: string, names = FIVE) {
    return importBackupIntoWork({ work, filePath: diskPath(fileName), scan: scanOf(names) });
  }

  test("中の話を全部選んだ状態で並べる。何話を足すかと、次の話・最後に加える・やめるを訊く（上書きは出さない）", async () => {
    const result = await importInto("003.txt");

    expect(listed.map((item) => [item.label, item.picked])).toEqual([
      ["第1話　転生前夜", true],
      ["第2話　朝", true],
      ["第3話　昼", true],
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toBe("3話を足します。どこへ足しますか？");
    expect(asked[0].titles).toEqual(["次の話として足す", "最後に加える", "やめる"]);
    expect(asked[0].detail).toContain("第4〜6話として3話を足します");
    expect(asked[0].detail).toContain("（2話。番号が3つずつ後ろへずれます）");
    expect(asked[0].detail).toContain("第6〜8話として3話を足します");
    // ［やめる］なら何も変わらない
    expect(result).toEqual({ changed: false });
    expect(manuscriptNames()).toEqual(FIVE);
  });

  test("［次の話として足す］：開いている話のすぐ次に順に差し込み、あとの話の番号を足した数だけずらす", async () => {
    press = "次の話として足す";

    const result = await importInto("003.txt");

    expect(result).toEqual({ changed: true, newFilePath: diskPath("004_転生前夜.txt") });
    expect(read("004_転生前夜.txt")).toBe("　夜が更けていく。\n");
    expect(read("005_朝.txt")).toBe("　朝が来た。｜漢字《かんじ》\n");
    expect(read("006_昼.txt")).toBe("　昼になった。\n");
    // 後ろの話は1回で3つずれる（名前の変わるのは1回だけ）
    expect(read("007.txt")).toBe("第004.txtの本文。\n");
    expect(read("008.txt")).toBe("第005.txtの本文。\n");
    expect(read("003.txt")).toBe("第003.txtの本文。\n");
    expect(manuscriptNames()).toEqual(
      ["001.txt", "002.txt", "003.txt", "004_転生前夜.txt", "005_朝.txt", "006_昼.txt", "007.txt", "008.txt"].sort()
    );
    expect(infos.join("\n")).toContain("3話を、第4〜6話として足しました");
    // 取り込み元は書き換えない
    expect(disk.get(zipPath)).toBe(ZIP);
  });

  test("［最後に加える］：最後の話の次の番号から順に、題をサブタイトルにして足す。ほかの話は変えない", async () => {
    press = "最後に加える";
    unpick = ["第2話　朝"];

    const result = await importInto("003.txt");

    expect(asked[0].message).toBe("2話を足します。どこへ足しますか？");
    expect(result).toEqual({ changed: true, newFilePath: diskPath("006_転生前夜.txt") });
    expect(read("006_転生前夜.txt")).toBe("　夜が更けていく。\n");
    expect(read("007_昼.txt")).toBe("　昼になった。\n");
    for (const name of FIVE) expect(read(name)).toBe(`第${name}の本文。\n`);
  });

  test("ルビの書き方：.txt の作品へはサイトの記法のまま、.md の作品へは {漢字|かんじ} へ（0.147.0 のテキストファイルと同じ）", async () => {
    const md = ["001.md", "002.md", "003.md"];
    for (const name of md) disk.set(diskPath(name), encoder.encode(`第${name}の本文。\n`));
    press = "最後に加える";
    unpick = ["第1話　転生前夜", "第3話　昼"];

    await importInto("003.md", md);

    expect(read("004_朝.md")).toBe("　朝が来た。{漢字|かんじ}\n");
  });

  test("文字コード・改行・BOM は手元の原稿に合わせる", async () => {
    const bom = [0xef, 0xbb, 0xbf];
    for (const name of FIVE) {
      disk.set(diskPath(name), new Uint8Array([...bom, ...encoder.encode(`第${name}の本文。\r\n`)]));
    }
    press = "最後に加える";
    unpick = ["第2話　朝", "第3話　昼"];

    await importInto("003.txt");

    const bytes = disk.get(diskPath("006_転生前夜.txt"));
    expect(bytes && [...bytes.slice(0, 3)]).toEqual(bom);
    expect(decoder.decode(bytes?.slice(3))).toBe("　夜が更けていく。\r\n");
  });

  test("1話だけ選んで、開いている話が空なら、確かめてからその話へ入れる", async () => {
    disk.set(diskPath("005.txt"), encoder.encode(""));
    unpick = ["第1話　転生前夜", "第3話　昼"];
    press = "入れる";

    const result = await importInto("005.txt");

    expect(asked).toHaveLength(1);
    expect(asked[0].message).toContain("「第2話　朝」を、この話（005.txt）へ入れます");
    expect(result.changed).toBe(true);
    // 題の置き場（サブタイトルの無いファイル名）があるので、名前に題を付ける
    expect(result.newFilePath).toBe(diskPath("005_朝.txt"));
    expect(read("005_朝.txt")).toBe("　朝が来た。｜漢字《かんじ》\n");
  });

  test("何話も選んだら、開いている話が空でもその話へは入れない", async () => {
    disk.set(diskPath("005.txt"), encoder.encode(""));

    await importInto("005.txt");

    expect(asked[0].titles).toEqual(["最後に加える", "やめる"]);
  });

  test("1話だけ選んで本文が入っていれば、上書きも並べる（0.147.0 と同じ）", async () => {
    unpick = ["第1話　転生前夜", "第3話　昼"];

    await importInto("003.txt");

    expect(asked[0].titles).toEqual(["次の話として足す", "最後に加える", "上書きする", "やめる"]);
  });

  test("ブラウザ版では［次の話として足す］を並べない", async () => {
    runtime.processes = false;

    await importInto("003.txt");

    expect(asked[0].titles).toEqual(["最後に加える", "やめる"]);
  });

  test("番号ずらしの途中で失敗したら、新しい話は1つも作らず、どこまで済んだかと空いた番号を言う", async () => {
    press = "次の話として足す";
    // 後ろから動かす：005→008 は済み、004→007 で止まる
    failRenameFrom = "004.txt";

    const result = await importInto("003.txt");

    expect(result.newFilePath).toBeUndefined();
    expect(read("008.txt")).toBe("第005.txtの本文。\n");
    expect(read("004.txt")).toBe("第004.txtの本文。\n");
    expect(manuscriptNames().some((name) => name.includes("転生前夜"))).toBe(false);
    expect(warnings.join("\n")).toContain("まだどこにも入れていません");
    // 何話ぶんもずらすときは空く番号が止まった所で変わるので、範囲を言い切らない
    expect(warnings.join("\n")).toContain("「004.txt」の手前まで");
    expect(warnings.join("\n")).toContain("番号が空いています");
    expect(warnings.join("\n")).not.toContain("第4〜6話の番号");
  });

  test("［最後に加える］の途中で中止したら、次の話は書かず、何話まで足したかを言う", async () => {
    press = "最後に加える";
    cancelAfterPlaced = "006_転生前夜.txt";

    const result = await importInto("003.txt");

    expect(result).toEqual({ changed: true, newFilePath: diskPath("006_転生前夜.txt") });
    expect(read("006_転生前夜.txt")).toBe("　夜が更けていく。\n");
    expect(manuscriptNames().some((name) => name.startsWith("007"))).toBe(false);
    expect(warnings.join("\n")).toContain("取り込みを中止しました。残りの2話は足していません。");
    expect(warnings.join("\n")).toContain("足したのは1話です（006_転生前夜.txt）");
    for (const name of FIVE) expect(read(name)).toBe(`第${name}の本文。\n`);
  });

  test("バックアップとして読めないものは、理由を出して何もしない", async () => {
    disk.set(zipPath, encoder.encode("ただのメモ。\n"));
    window.showOpenDialog = async () => [Uri.file(zipPath.replace(/\.zip$/, ".txt"))];
    disk.set(zipPath.replace(/\.zip$/, ".txt"), encoder.encode("ただのメモ。\n"));

    const result = await importInto("003.txt");

    expect(result).toEqual({ changed: false });
    expect(asked[0]?.message).toContain("取り込める形のバックアップではありませんでした");
    expect(manuscriptNames()).toEqual(FIVE);
  });

  test("開いている話に競合の印があれば、訊く前に止める", async () => {
    disk.set(diskPath("003.txt"), encoder.encode("<<<<<<< HEAD\nあ\n=======\nい\n>>>>>>> other\n"));
    press = "最後に加える";

    const result = await importInto("003.txt");

    expect(result).toEqual({ changed: false });
    expect(asked).toEqual([]);
    expect(errors.join("\n")).toContain("競合");
  });
});
