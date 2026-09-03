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
 * 書き出しが作者へ伝えること（設計書6.65.8・6.65.10）。
 *
 * **本は出す。ただし黙って捨てない。** 挿絵が入らなかった・話が本から
 * 外れた・表紙が読めなかった——どれも作者が次にすることが変わるので、
 * 完了通知（と失敗の通知）の文言そのものを見張る。
 *
 * ここは作り物のファイルシステムで `exportEpub` をそのまま動かす。
 * 通知の文言を別に組み直すと、**製品に無い文言を確かめたことになる**。
 */

const work: WorkEntry = {
  id: "work_epub_notices",
  title: "氷の街",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-09-03T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
/** 画面に出た知らせ（種類つき） */
const shown: Array<{ kind: string; text: string }> = [];

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function put(relativePath: string, text: string): void {
  disk.set(
    diskPath(path.join(work.folderPath, relativePath)),
    new TextEncoder().encode(text)
  );
}

function putBytes(relativePath: string, bytes: number[]): void {
  disk.set(
    diskPath(path.join(work.folderPath, relativePath)),
    new Uint8Array(bytes)
  );
}

/** その種類の知らせを1つにつないだもの（何が出たかだけを見る） */
function textOf(kind: string): string {
  return shown
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.text)
    .join("\n");
}

/** 作り物のファイルシステム。キーは `Uri.file` が返す形に揃える */
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
        return { mtime: Date.UTC(2026, 8, 3, 5, 0, 0), size: 1 };
      }
      // 中に何か入っていればフォルダとして見える（走査が通るように）
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

beforeEach(() => {
  disk.clear();
  shown.length = 0;
  installDisk();

  window.showInformationMessage = async (message: string) => {
    shown.push({ kind: "info", text: message });
    return undefined;
  };
  window.showWarningMessage = async (message: string) => {
    shown.push({ kind: "warning", text: message });
    return undefined;
  };
  window.showErrorMessage = async (message: string) => {
    shown.push({ kind: "error", text: message });
    return undefined;
  };
});

/** 競合マーカー。行頭の7文字（`textFile.ts` の見分け方に合わせる） */
const CONFLICT = "<".repeat(7);

function writeBook(config: Record<string, unknown>): void {
  put("設定/書籍/book.json", JSON.stringify(config));
}

describe("競合で外れた話に置いていた指定（設計書6.65.10）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい\n\nう");
    put("本文/第2話.txt", `${CONFLICT} HEAD\nあ\nい`);
    putBytes("素材/挿絵.png", [0x89, 0x50, 0x4e, 0x47]);
  });

  test("外れた話の挿絵・改ページも入らないことを、件数で伝える", async () => {
    writeBook({
      title: "氷の街",
      illustrations: [
        {
          episodePath: "本文/第2話.txt",
          afterParagraph: 1,
          imagePath: "素材/挿絵.png",
          caption: "",
        },
        {
          episodePath: "本文/第2話.txt",
          afterParagraph: 2,
          imagePath: "素材/挿絵.png",
          caption: "",
        },
      ],
      pageBreaks: [{ episodePath: "本文/第2話.txt", afterParagraph: 1 }],
    });

    await exportEpub(work);
    const info = textOf("info");

    expect(info).toContain("EPUBを書き出しました");
    // 話が外れたことは、いままでどおり伝える
    expect(info).toContain("第2話.txt");
    // **指定も一緒に消えたことを言う**（これが無いと、挿絵が入らない
    // 理由が作者に分からない）
    expect(info).toContain("挿絵2件");
    expect(info).toContain("改ページ1件");
  });

  test("外れた話に指定が無ければ、余計なことは言わない", async () => {
    writeBook({ title: "氷の街" });

    await exportEpub(work);
    const info = textOf("info");

    expect(info).toContain("第2話.txt");
    expect(info).not.toContain("挿絵");
    expect(info).not.toContain("改ページ");
  });

  test("本に入った話の指定は、外れたとは言わない", async () => {
    writeBook({
      title: "氷の街",
      illustrations: [
        {
          episodePath: "本文/第1話.txt",
          afterParagraph: 1,
          imagePath: "素材/挿絵.png",
          caption: "",
        },
      ],
    });

    await exportEpub(work);

    expect(textOf("info")).not.toContain("挿絵1件");
  });
});

describe("表紙・裏表紙が読めないとき（設計書6.65.8）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
  });

  /**
   * **裏表紙の失敗は、裏表紙の言葉で伝える。**
   *
   * 表紙とまとめて捕まえていたので、裏表紙が読めないときにも
   * 「coverImagePath を確かめてください」と案内していた（直す先が違う）。
   */
  test("裏表紙が読めないときは、backCoverImagePath を案内する", async () => {
    putBytes("素材/表紙.png", [0x89, 0x50]);
    writeBook({
      title: "氷の街",
      coverImagePath: "素材/表紙.png",
      // 置いていないファイルを指す（読めない）
      backCoverImagePath: "素材/裏表紙.png",
    });

    await exportEpub(work);
    const error = textOf("error");

    expect(error).toContain("裏表紙の画像を読めませんでした");
    expect(error).toContain("backCoverImagePath");
    expect(error).not.toContain("coverImagePath を確かめて");
    // 読めないまま本を出さない（表紙のときと同じ扱い）
    expect(textOf("info")).toBe("");
  });

  test("表紙が読めないときは、いままでどおり coverImagePath を案内する", async () => {
    writeBook({ title: "氷の街", coverImagePath: "素材/表紙.png" });

    await exportEpub(work);
    const error = textOf("error");

    expect(error).toContain("表紙の画像を読めませんでした");
    expect(error).toContain("coverImagePath");
    expect(error).not.toContain("backCoverImagePath");
  });

  test("どちらも読めれば、本は出る", async () => {
    putBytes("素材/表紙.png", [0x89, 0x50]);
    putBytes("素材/裏表紙.png", [0x89, 0x50]);
    writeBook({
      title: "氷の街",
      coverImagePath: "素材/表紙.png",
      backCoverImagePath: "素材/裏表紙.png",
    });

    await exportEpub(work);

    expect(textOf("error")).toBe("");
    expect(textOf("info")).toContain("EPUBを書き出しました");
  });
});

/**
 * 面の並び（設計書6.65.15の段B）。
 *
 * **中身の読めない面だけを外して、本は出す**（挿絵と同じ流儀）。
 * あとがきだけは、**まだ書いていないときに黙る**——既定の並びに面が
 * 入っているので、書かない作者にも毎回言うことになる。
 */
describe("口絵・あとがきの面（設計書6.65.15）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
  });

  /** 書き出された本を開き直す（ZIPの中の名前だけを見る） */
  function exported(): string[] {
    const found = [...disk.entries()].find(([name]) => name.endsWith(".epub"));
    if (!found) throw new Error("EPUBが書き出されていません");
    return Object.keys(unzipSync(found[1]));
  }

  test("あとがきの原稿があれば、面として本へ入る", async () => {
    writeBook({ title: "氷の街" });
    put("設定/書籍/あとがき.md", "お読みいただきありがとうございました。");

    await exportEpub(work);

    expect(exported()).toContain("OEBPS/afterword.xhtml");
    // 入ったことは面の存在で分かる。余計な知らせは足さない
    expect(textOf("info")).not.toContain("あとがき");
  });

  test("あとがきの原稿がまだ無ければ、何も言わない（面も出ない）", async () => {
    writeBook({ title: "氷の街" });

    await exportEpub(work);

    expect(exported()).not.toContain("OEBPS/afterword.xhtml");
    expect(textOf("info")).not.toContain("あとがき");
  });

  test("原稿はあるのに中身が無ければ、入らなかったことを伝える", async () => {
    writeBook({ title: "氷の街" });
    // 雛形のまま（付箋の行だけ）は「まだ書いていない」と読む
    put("設定/書籍/あとがき.md", "// ここにあとがきを書いてください\n");

    await exportEpub(work);

    expect(exported()).not.toContain("OEBPS/afterword.xhtml");
    expect(textOf("info")).toContain("あとがき");
    expect(textOf("info")).toContain("EPUBを書き出しました");
  });

  test("口絵の画像が読めなければ、その面だけ外して本は出す", async () => {
    writeBook({
      title: "氷の街",
      blocks: [
        { type: "cover" },
        { type: "frontIllustration", imagePath: "素材/無い口絵.png" },
        { type: "body" },
      ],
    });

    await exportEpub(work);
    const info = textOf("info");

    expect(info).toContain("EPUBを書き出しました");
    expect(info).toContain("口絵");
    expect(info).toContain("素材/無い口絵.png");
    expect(exported()).not.toContain("OEBPS/plate-page-1.xhtml");
  });

  test("画像が置いてあれば、口絵の面が本へ入る", async () => {
    putBytes("素材/口絵.png", [0x89, 0x50, 0x4e, 0x47]);
    writeBook({
      title: "氷の街",
      blocks: [
        { type: "cover" },
        { type: "frontIllustration", imagePath: "素材/口絵.png", caption: "朝" },
        { type: "body" },
      ],
    });

    await exportEpub(work);
    const names = exported();

    expect(names).toContain("OEBPS/plate-page-1.xhtml");
    expect(names).toContain("OEBPS/plate-1.png");
    expect(textOf("info")).not.toContain("読めませんでした");
  });
});
