import * as path from "path";
import { zipSync } from "fflate";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, FileType, Uri, window, workspace } from "../support/vscodeStub";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { emptyCounts } from "../../../src/core/charCount";
import { importIntoEpisode } from "../../../src/features/manuscriptImport";

/** ブラウザ版のふり（外部プロセスを起動できない） */
const runtime = vi.hoisted(() => ({ processes: true }));
vi.mock("../../../src/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/runtime")>();
  return { ...actual, canRunProcesses: () => runtime.processes };
});
import { cancelRunningTask } from "../../../src/views/progress";

/**
 * 原稿エディターの［入力］→「テキストファイルから」「Word から」（作者の決定 2026-11-08。
 * 設計書6.25.13）。窓・読み・書きの道を、メモリ上のファイル置き場で通す。
 * 判断の部分（空か・何を並べるか・差し替え方）は `test/unit/core/episodeImport.test.ts`。
 *
 * **Git系は範囲外**（`insertRemoveEpisode.test.ts` と同じ）。作品フォルダは実在しないので、
 * 番号ずらしのあとの「名前だけのコミット」の確認は出ない。
 */

const work: WorkEntry = {
  id: "work_import",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "import"),
  registeredAt: "2026-11-08T00:00:00.000Z",
};
const manuscriptDir = Uri.file(path.join(work.folderPath, "本文")).fsPath;
const sourcePath = Uri.file(path.join("C:", "外", "取り込む.txt")).fsPath;
const wordPath = Uri.file(path.join("C:", "外", "雪の朝.docx")).fsPath;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function diskPath(fileName: string): string {
  return Uri.file(path.join(manuscriptDir, fileName)).fsPath;
}

function episode(fileName: string, overrides: Partial<EpisodeFile> = {}): EpisodeFile {
  const numberMatch = /^(\d+)\.txt$/.exec(fileName);
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
    ...overrides,
  };
}

const FIVE = ["001.txt", "002.txt", "003.txt", "004.txt", "005.txt"];

function scanOf(names: readonly string[] = FIVE) {
  return { episodes: names.map((name) => episode(name)), manuscriptDir };
}

/** 窓で押されたボタンと、出た説明を控える */
interface Asked {
  message: string;
  detail: string;
  titles: string[];
}

describe("原稿エディターの取り込み", () => {
  const disk = new Map<string, Uint8Array>();
  let asked: Asked[];
  let errors: string[];
  let warnings: string[];
  let infos: string[];
  /** 窓で押すボタン（無ければ何も押さない） */
  let press: string | undefined;
  /** 窓が出たときに走らせる（外で書き換えられた、を写す） */
  let onAsk: (() => void) | undefined;
  /** この名前の付け替えで失敗させる */
  let failRenameFrom: string | undefined;
  /** この名前の付け替えが済んだら、中止ボタンを押す */
  let cancelAfterRename: string | undefined;

  const read = (fileName: string) => decoder.decode(disk.get(diskPath(fileName)));

  beforeEach(() => {
    disk.clear();
    asked = [];
    errors = [];
    warnings = [];
    infos = [];
    press = undefined;
    onAsk = undefined;
    failRenameFrom = undefined;
    cancelAfterRename = undefined;
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
        if (cancelAfterRename && path.basename(from.fsPath) === cancelAfterRename) {
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

    window.showOpenDialog = async () => [Uri.file(sourcePath)];
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
        asked.push({
          message,
          detail: options.detail ?? "",
          titles: buttons.map((button) => button.title),
        });
        onAsk?.();
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

  function importInto(fileName: string, source: "text" | "word" = "text", names = FIVE) {
    return importIntoEpisode({
      work,
      filePath: diskPath(fileName),
      source,
      scan: scanOf(names),
    });
  }

  test("空の話へは訊かずに入る。冒頭の欄（題など）は残る", async () => {
    disk.set(
      diskPath("005.txt"),
      encoder.encode("【タイトル】\n第五話　雪の朝\n\n【公開状態】\n未公開\n\n【本文】\n")
    );
    disk.set(sourcePath, encoder.encode("　取り込んだ一行目。\n二行目。\n"));

    const result = await importInto("005.txt");

    expect(asked).toEqual([]);
    expect(result).toEqual({ changed: true });
    expect(read("005.txt")).toBe(
      "【タイトル】\n第五話　雪の朝\n\n【公開状態】\n未公開\n\n【本文】\n　取り込んだ一行目。\n二行目。\n"
    );
    // 取り込み元は書き換えない
    expect(decoder.decode(disk.get(sourcePath))).toBe("　取り込んだ一行目。\n二行目。\n");
  });

  test("本文が入っている話では、次の話・最後に加える・上書き・やめるを訊く", async () => {
    disk.set(sourcePath, encoder.encode("新しい話。\n"));

    const result = await importInto("003.txt");

    expect(result).toEqual({ changed: false });
    expect(asked).toHaveLength(1);
    expect(asked[0].titles).toEqual(["次の話として足す", "最後に加える", "上書きする", "やめる"]);
    // 004・005 の2話の名前が変わる
    expect(asked[0].detail).toContain("あとの話のファイル名が変わります（2話）");
    expect(asked[0].detail).toContain("「006.txt」");
    // ［やめる］なら何も変わらない
    expect([...disk.keys()].filter((key) => key.startsWith(manuscriptDir)).sort()).toEqual(
      FIVE.map(diskPath).sort()
    );
  });

  test("最後の話では、次の話と最後に加えるが1つになる（最後に加える・上書き・やめる）", async () => {
    disk.set(sourcePath, encoder.encode("新しい話。\n"));

    await importInto("005.txt");

    expect(asked[0].titles).toEqual(["最後に加える", "上書きする", "やめる"]);
  });

  test("ブラウザ版では［次の話として足す］を並べない（番号ずらしは手元の VS Code だけ）", async () => {
    disk.set(sourcePath, encoder.encode("新しい話。\n"));
    runtime.processes = false;

    await importInto("003.txt");

    expect(asked[0].titles).toEqual(["最後に加える", "上書きする", "やめる"]);
  });

  test("［次の話として足す］：あとの話の番号を1つずつずらし、空いた番号へ入れる", async () => {
    disk.set(sourcePath, encoder.encode("差し込む話。\n"));
    press = "次の話として足す";

    const result = await importInto("003.txt");

    expect(result).toEqual({ changed: true, newFilePath: diskPath("004.txt") });
    expect(read("004.txt")).toBe("差し込む話。\n");
    expect(read("005.txt")).toBe("第004.txtの本文。\n");
    expect(read("006.txt")).toBe("第005.txtの本文。\n");
    expect(read("003.txt")).toBe("第003.txtの本文。\n");
  });

  test("［最後に加える］：最後の話の次の番号で足し、ほかの話は変えない", async () => {
    disk.set(sourcePath, encoder.encode("最後の話。\n"));
    press = "最後に加える";

    const result = await importInto("003.txt");

    expect(result).toEqual({ changed: true, newFilePath: diskPath("006.txt") });
    expect(read("006.txt")).toBe("最後の話。\n");
    for (const name of FIVE) expect(read(name)).toBe(`第${name}の本文。\n`);
  });

  test("［上書きする］：消える字数を窓に出し、本文を置き換え、書く前の本文を控えに残す", async () => {
    disk.set(sourcePath, encoder.encode("置き換えた本文。\n"));
    press = "上書きする";

    const result = await importInto("003.txt");

    // 「第003.txtの本文。」の純文字数
    expect(asked[0].detail).toContain("いまの本文 12字が消え");
    expect(result).toEqual({ changed: true });
    expect(read("003.txt")).toBe("置き換えた本文。\n");
    const recovery = [...disk.keys()].filter((key) => key.includes(".novelai-recovery"));
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery.some((key) => decoder.decode(disk.get(key)) === "第003.txtの本文。\n")).toBe(true);
    expect(infos.join("\n")).toContain("書き換える前の本文は控え");
  });

  test("窓を出したあとで外で書き換えられたら、ハッシュが合わないので上書きしない", async () => {
    disk.set(sourcePath, encoder.encode("置き換えた本文。\n"));
    press = "上書きする";
    onAsk = () => disk.set(diskPath("003.txt"), encoder.encode("外のアプリで直した本文。\n"));

    const result = await importInto("003.txt");

    expect(result).toEqual({ changed: false });
    expect(read("003.txt")).toBe("外のアプリで直した本文。\n");
    expect(errors.join("\n")).toContain("取り込んでいません");
    expect(errors.join("\n")).toContain("外で書き換えられました");
  });

  test("開いている話に競合の印があれば、訊く前に止める", async () => {
    disk.set(diskPath("003.txt"), encoder.encode("<<<<<<< HEAD\nあ\n=======\nい\n>>>>>>> other\n"));
    disk.set(sourcePath, encoder.encode("新しい話。\n"));
    press = "上書きする";

    const result = await importInto("003.txt");

    expect(result).toEqual({ changed: false });
    expect(asked).toEqual([]);
    expect(errors.join("\n")).toContain("競合");
    expect(read("003.txt")).toContain("<<<<<<<");
  });

  test("番号ずらしの途中で失敗したら、新しい話は作らず、どこまで済んだかと空いた番号を言う", async () => {
    disk.set(sourcePath, encoder.encode("差し込む話。\n"));
    press = "次の話として足す";
    // 後ろから動かす：005→006 は済み、004→005 で止まる
    failRenameFrom = "004.txt";

    const result = await importInto("003.txt");

    expect(result.newFilePath).toBeUndefined();
    expect(read("006.txt")).toBe("第005.txtの本文。\n");
    expect(read("004.txt")).toBe("第004.txtの本文。\n");
    expect(disk.has(diskPath("005.txt"))).toBe(false);
    // 取り込む文はどこにも入っていない（本文は1文字も失われていない）
    const texts = [...disk.values()].map((bytes) => decoder.decode(bytes));
    expect(texts.filter((text) => text.includes("差し込む話。"))).toHaveLength(1); // 取り込み元だけ
    expect(errors.join("\n")).toContain("1件は済みました");
    expect(warnings.join("\n")).toContain("まだどこにも入れていません");
    expect(warnings.join("\n")).toContain("第5話の番号が空いています");
  });

  test("番号ずらしの途中で中止したら、そこで止まり、新しい話は作らない", async () => {
    disk.set(sourcePath, encoder.encode("差し込む話。\n"));
    press = "次の話として足す";
    // 005→006 を動かしたところで中止ボタンを押す
    cancelAfterRename = "005.txt";

    const result = await importInto("003.txt");

    expect(result.newFilePath).toBeUndefined();
    expect(read("006.txt")).toBe("第005.txtの本文。\n");
    expect(read("004.txt")).toBe("第004.txtの本文。\n");
    expect(errors.join("\n")).toContain("中止しました");
    expect(warnings.join("\n")).toContain("まだどこにも入れていません");
  });

  test("Shift_JIS のテキストファイルを読み分けて取り込む", async () => {
    disk.set(diskPath("005.txt"), encoder.encode(""));
    // 「あいう」を Shift_JIS で
    disk.set(sourcePath, new Uint8Array([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4]));

    const result = await importInto("005.txt");

    expect(result).toEqual({ changed: true });
    expect(read("005.txt")).toBe("あいう\n");
    expect(infos.join("\n")).toContain("Shift_JIS として読みました");
  });

  test("読めない（化ける）テキストファイルは取り込まず、理由を出す", async () => {
    disk.set(diskPath("005.txt"), encoder.encode(""));
    disk.set(sourcePath, new Uint8Array([0x82, 0xa0, 0xff, 0xff, 0x82]));

    const result = await importInto("005.txt");

    expect(result).toEqual({ changed: false });
    expect(read("005.txt")).toBe("");
    expect(warnings.join("\n")).toContain("文字コードを読み分けられませんでした");
  });

  test("Word の文書を取り込む（.txt の話へはルビを投稿サイトの記法で入れる）", async () => {
    disk.set(diskPath("005.txt"), encoder.encode(""));
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      "<w:p><w:r><w:t>雪の</w:t></w:r>" +
      '<w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="center"/></w:rubyPr>' +
      "<w:rt><w:r><w:t>あさ</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>朝</w:t></w:r></w:rubyBase></w:ruby></w:r>" +
      "<w:r><w:t>だった。</w:t></w:r></w:p>" +
      "</w:body></w:document>";
    disk.set(wordPath, zipSync({ "word/document.xml": encoder.encode(documentXml) }));
    window.showOpenDialog = async () => [Uri.file(wordPath)];

    const result = await importInto("005.txt", "word");

    expect(result).toEqual({ changed: true });
    expect(read("005.txt")).toBe("雪の｜朝《あさ》だった。\n");
  });

  test("Word として読めないものは取り込まない", async () => {
    disk.set(diskPath("005.txt"), encoder.encode(""));
    disk.set(wordPath, encoder.encode("これは Word の文書ではありません"));
    window.showOpenDialog = async () => [Uri.file(wordPath)];

    const result = await importInto("005.txt", "word");

    expect(result).toEqual({ changed: false });
    expect(read("005.txt")).toBe("");
    expect(warnings.join("\n")).toContain("Word の文書として読めませんでした");
  });
});
