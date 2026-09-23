import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { unzipSync } from "fflate";
import { exportEpub } from "../../src/features/exportEpub";
import type { WorkEntry } from "../../src/models/types";
import {
  FileSystemError,
  FileType,
  Uri,
  window,
  workspace,
} from "./support/vscodeStub";

/**
 * 「章ごとに区切る」目次の束ね（設計書6.66.4の3・6.65.7の4）。
 *
 * 目次の章は長らくファイル名から読み取れるもの（種別と話数）だけで
 * 束ねていた——**章の情報がどこにも無かった**からである。章立ての台帳
 * （6.66）ができたので、台帳があればそちらが正になる。
 *
 * 作り物のファイルシステムで `exportEpub` をそのまま動かし、本の
 * `nav.xhtml` を開いて確かめる。目次を別に組み直すと、**製品に無い目次**
 * を見たことになる。
 */

const work: WorkEntry = {
  id: "work_epub_chapter_toc",
  title: "氷の街",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
const shown: string[] = [];

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function put(relativePath: string, text: string): void {
  disk.set(
    diskPath(path.join(work.folderPath, relativePath)),
    new TextEncoder().encode(text)
  );
}

function installDisk(): void {
  const separator = path.sep;
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
      if (disk.has(uri.fsPath)) {
        return { mtime: Date.UTC(2026, 8, 4, 5, 0, 0), size: 1 };
      }
      const prefix = uri.fsPath + separator;
      for (const key of disk.keys()) {
        if (key.startsWith(prefix)) return { mtime: 0, size: 0 };
      }
      throw new FileSystemError("missing", "FileNotFound");
    },
    readDirectory: async (uri: { fsPath: string }) => {
      const prefix = uri.fsPath + separator;
      const names = new Map<string, FileType>();
      for (const key of disk.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(separator);
        if (cut < 0) names.set(rest, FileType.File);
        else names.set(rest.slice(0, cut), FileType.Directory);
      }
      if (names.size === 0) throw new FileSystemError("missing", "FileNotFound");
      return [...names.entries()];
    },
  } as unknown as typeof workspace.fs;
}

/** 書き出された本の中の1ファイルを読む */
function inBook(name: string): string {
  const found = [...disk.entries()].find(([key]) => key.endsWith(".epub"));
  if (!found) throw new Error("EPUBが書き出されていません");
  const entry = unzipSync(found[1])[name];
  if (!entry) throw new Error(`${name} が本の中にありません`);
  return new TextDecoder().decode(entry);
}

/** 目次の束ね名（`<span class="toc-group">` の中身）を上から並べる */
function groups(): string[] {
  const nav = inBook("OEBPS/nav.xhtml");
  return [...nav.matchAll(/<span class="toc-group">(.*?)<\/span>/g)].map(
    (matched) => matched[1]
  );
}

function writeBook(config: Record<string, unknown>): void {
  put("設定/書籍/book.json", JSON.stringify(config));
}

function writeChapters(
  chapters: Array<{ name: string; startEpisodePath: string }>
): void {
  put("設定/章立て.json", JSON.stringify({ schemaVersion: "1", chapters }));
}

beforeEach(() => {
  disk.clear();
  shown.length = 0;
  installDisk();
  window.showInformationMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  window.showWarningMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  window.showErrorMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };

  for (const n of [1, 2, 3, 4]) put(`本文/第${n}話.txt`, "あ\n\nい");
  // 目次は「章ごとに区切る」。ここが `chapters` でなければ束ねは効かない
  writeBook({ title: "氷の街", tocPattern: "chapters" });
});

describe("目次の章は、台帳があれば台帳が正（設計書6.66.4の3）", () => {
  test("台帳の章名で束ねる", async () => {
    writeChapters([
      { name: "第一章　出立", startEpisodePath: "本文/第2話.txt" },
      { name: "第二章　邂逅", startEpisodePath: "本文/第4話.txt" },
    ]);

    await exportEpub(work);

    // 「本編」（ファイル名由来の束ね）はもう出ない
    expect(groups()).toEqual(["第一章　出立", "第二章　邂逅"]);
  });

  test("最初の章より前の話は、章に包まれない", async () => {
    writeChapters([{ name: "第一章", startEpisodePath: "本文/第2話.txt" }]);

    await exportEpub(work);
    const nav = inBook("OEBPS/nav.xhtml");

    // 第1話の行は章の見出しより上にある（章の外＝一覧のまま）。
    // 既定は縦書きなので、話数の「1」は縦中横のspanで包まれる
    expect(nav.indexOf('第<span class="tcy">1</span>話')).toBeLessThan(
      nav.indexOf("第一章")
    );
  });

  test("台帳が無ければ、従来のファイル名由来の束ねのまま", async () => {
    await exportEpub(work);

    expect(groups()).toEqual(["本編"]);
  });

  test("台帳が空でも、従来の束ねのまま", async () => {
    writeChapters([]);

    await exportEpub(work);

    expect(groups()).toEqual(["本編"]);
  });

  test("開始の話が見つからない章では、その章に束ねない", async () => {
    writeChapters([
      { name: "第一章", startEpisodePath: "本文/第2話.txt" },
      { name: "幻の章", startEpisodePath: "本文/消えた話.txt" },
    ]);

    await exportEpub(work);

    expect(groups()).toEqual(["第一章"]);
  });

  test("台帳が壊れていても本は出す。ただし黙らない", async () => {
    put("設定/章立て.json", "{壊れています");

    await exportEpub(work);

    // 本は出る（従来の束ねへ倒す）
    expect(groups()).toEqual(["本編"]);
    // 章名で束ねなかった理由は伝える
    expect(shown.join("\n")).toContain("章立て");
  });
});
