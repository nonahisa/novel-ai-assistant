import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { zipSync } from "fflate";
import { convertDocxToMarkdown } from "../../src/features/docxImport";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, FileType, Uri, window, workspace } from "./support/vscodeStub";
import { cancelRunningTask } from "../../src/views/progress";

/**
 * Word（.docx）を .md へ一括変換する（設計書6.85）。
 *
 * ここで見るのは**原稿を壊さないこと**の3点である。
 *
 * 1. 元の .docx に触れない（変換であって、移動ではない）
 * 2. 既にある .md を上書きしない（別名で書き出す）
 * 3. 落としたもの・失敗したものを、件数で伝える
 *
 * 作り物のファイルシステムで `convertDocxToMarkdown` をそのまま動かす。
 * 通知の文言を別に組み直すと、**製品に無い文言を確かめたことになる**。
 */

const work: WorkEntry = {
  id: "work_docx",
  title: "氷の街",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-09-06T00:00:00.000Z",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const disk = new Map<string, Uint8Array>();
const shown: Array<{ kind: string; text: string }> = [];

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function put(relativePath: string, bytes: Uint8Array): void {
  disk.set(diskPath(path.join(work.folderPath, relativePath)), bytes);
}

function read(relativePath: string): string | undefined {
  const bytes = disk.get(diskPath(path.join(work.folderPath, relativePath)));
  return bytes ? decoder.decode(bytes) : undefined;
}

/** 本文フォルダーに置くファイルの名前だけ（拡張子込み） */
function manuscriptNames(): string[] {
  const prefix = diskPath(path.join(work.folderPath, "本文")) + path.sep;
  return [...disk.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort();
}

/** 段落を並べただけの .docx */
function docxOf(inner: string): Uint8Array {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${inner}</w:body></w:document>`;
  return zipSync({ "word/document.xml": encoder.encode(xml) });
}

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
      if (disk.has(uri.fsPath)) return { mtime: 0, size: 1 };
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

/** 「この作品の本文フォルダー」を選び、確認では「変換する」を押す */
function answerDialogs(): void {
  (window as unknown as Record<string, unknown>).showQuickPick = async (
    items: Array<Record<string, unknown>>
  ) => items.find((item) => item.choice === "work");
  window.showWarningMessage = (async (
    message: string,
    ...rest: unknown[]
  ) => {
    // **detail まで積む。** 確認の窓で作者が読むのは2つ合わせた文であり、
    // 見出しだけを見張ると、書き出し先が消えても気づけない
    const options = rest[0] as { detail?: string } | undefined;
    shown.push({
      kind: "warning",
      text: [message, options?.detail ?? ""].join("\n"),
    });
    const labels = rest.filter((item): item is string => typeof item === "string");
    return labels[0];
  }) as typeof window.showWarningMessage;
}

/**
 * 進捗の窓。**渡された処理をそのまま走らせる。**
 *
 * @param cancelAfter この回数だけ進み具合を出したら、中止ボタンを押した
 *   ことにする（`cancelRunningTask` は本物を呼ぶ——止まり方そのものを
 *   確かめたいので、作り物のトークンを差し込まない）
 */
function answerProgress(cancelAfter?: number): void {
  let reports = 0;
  (window as unknown as Record<string, unknown>).withProgress = async (
    _options: unknown,
    task: (progress: { report(value: unknown): void }) => Promise<unknown>
  ) =>
    task({
      report: () => {
        reports += 1;
        if (cancelAfter !== undefined && reports === cancelAfter) {
          void cancelRunningTask();
        }
      },
    });
}

beforeEach(() => {
  disk.clear();
  shown.length = 0;
  installDisk();
  answerDialogs();
  answerProgress();

  window.showInformationMessage = (async (message: string) => {
    shown.push({ kind: "info", text: message });
    return undefined;
  }) as typeof window.showInformationMessage;
  window.showErrorMessage = (async (message: string) => {
    shown.push({ kind: "error", text: message });
    return undefined;
  }) as typeof window.showErrorMessage;
});

describe("一括変換（設計書6.85）", () => {
  test("ルビを保ったまま .md を作り、.docx はそのまま残す", async () => {
    const docx = docxOf(
      "<w:p><w:r><w:t>次の</w:t></w:r>" +
        "<w:r><w:ruby><w:rt><w:r><w:t>かんじ</w:t></w:r></w:rt>" +
        "<w:rubyBase><w:r><w:t>漢字</w:t></w:r></w:rubyBase></w:ruby></w:r>" +
        "<w:r><w:t>です</w:t></w:r></w:p>"
    );
    put(path.join("本文", "第1話.docx"), docx);

    const done = await convertDocxToMarkdown(work);

    expect(done).toBe(true);
    expect(read(path.join("本文", "第1話.md"))).toBe("次の{漢字|かんじ}です\n");
    // **元は消さない。** 変換であって、移動ではない
    expect(read(path.join("本文", "第1話.docx"))).toBeDefined();
    expect(textOf("info")).toContain("1件を .md にしました");
    expect(textOf("info")).toContain("ルビ1件");
  });

  test("同じ名前の .md があれば、上書きせず別名で書き出す", async () => {
    put(path.join("本文", "第1話.docx"), docxOf("<w:p><w:r><w:t>新しい</w:t></w:r></w:p>"));
    put(path.join("本文", "第1話.md"), encoder.encode("もとからある本文"));

    await convertDocxToMarkdown(work);

    // **先にあった .md は1文字も変わらない**
    expect(read(path.join("本文", "第1話.md"))).toBe("もとからある本文");
    const added = manuscriptNames().filter(
      (name) => name.endsWith(".md") && name !== "第1話.md"
    );
    expect(added).toHaveLength(1);
    expect(
      read(path.join("本文", added[0]))
    ).toBe("新しい\n");
  });

  test("Word の一時ファイル（~$）は対象にしない", async () => {
    put(path.join("本文", "第1話.docx"), docxOf("<w:p><w:r><w:t>本文</w:t></w:r></w:p>"));
    put(path.join("本文", "~$第1話.docx"), encoder.encode("ごみ"));

    await convertDocxToMarkdown(work);

    expect(manuscriptNames()).not.toContain("~$第1話.md");
    expect(textOf("info")).toContain("1件を .md にしました");
  });

  test("古い .doc は対象外と案内し、変換できるものが無ければ何も作らない", async () => {
    put(path.join("本文", "第1話.doc"), encoder.encode("古い形式"));

    const done = await convertDocxToMarkdown(work);

    expect(done).toBe(false);
    expect(textOf("info")).toContain(".doc");
    expect(manuscriptNames()).toEqual(["第1話.doc"]);
  });

  test("読めないファイルがあっても、読めたものは残す", async () => {
    put(path.join("本文", "第1話.docx"), docxOf("<w:p><w:r><w:t>読めた</w:t></w:r></w:p>"));
    put(path.join("本文", "第2話.docx"), encoder.encode("これはZIPではない"));

    await convertDocxToMarkdown(work);

    expect(read(path.join("本文", "第1話.md"))).toBe("読めた\n");
    expect(manuscriptNames()).not.toContain("第2話.md");
    const info = textOf("info");
    expect(info).toContain("1件を .md にしました");
    expect(info).toContain("第2話.docx");
  });

  test("落としたものは、ファイル名を添えて件数で伝える", async () => {
    put(
      path.join("本文", "第1話.docx"),
      docxOf(
        "<w:p><w:r><w:t>本文</w:t></w:r>" +
          "<w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p>"
      )
    );

    await convertDocxToMarkdown(work);

    const info = textOf("info");
    expect(info).toContain("第1話.docx");
    expect(info).toContain("画像 1件");
  });

  test("確認で取りやめたら、1件も作らない", async () => {
    put(path.join("本文", "第1話.docx"), docxOf("<w:p><w:r><w:t>本文</w:t></w:r></w:p>"));
    window.showWarningMessage = (async (message: string) => {
      // Esc で閉じた（＝何も押さなかった）体にする
      shown.push({ kind: "warning", text: message });
      return undefined;
    }) as typeof window.showWarningMessage;

    const done = await convertDocxToMarkdown(work);

    expect(done).toBe(false);
    expect(manuscriptNames()).toEqual(["第1話.docx"]);
  });

  test("途中で中止しても、そこまでの .md は残す", async () => {
    put(path.join("本文", "第1話.docx"), docxOf("<w:p><w:r><w:t>一話目</w:t></w:r></w:p>"));
    put(path.join("本文", "第2話.docx"), docxOf("<w:p><w:r><w:t>二話目</w:t></w:r></w:p>"));
    // 1件目に取りかかったところで中止ボタンを押す
    answerProgress(1);

    await convertDocxToMarkdown(work);

    // **出来上がったものは巻き戻さない**（作者が失うもののほうが大きい）
    expect(read(path.join("本文", "第1話.md"))).toBe("一話目\n");
    expect(read(path.join("本文", "第2話.md"))).toBeUndefined();
    const info = textOf("info");
    expect(info).toContain("中止しました");
    expect(info).toContain("1件まで");
  });

  test("確認には、件数と書き出し先が出る", async () => {
    put(path.join("本文", "第1話.docx"), docxOf("<w:p><w:r><w:t>本文</w:t></w:r></w:p>"));
    put(path.join("本文", "第2話.docx"), docxOf("<w:p><w:r><w:t>本文</w:t></w:r></w:p>"));

    await convertDocxToMarkdown(work);

    const warning = textOf("warning");
    expect(warning).toContain("2件");
    expect(warning).toContain("本文");
  });
});

describe("書き出しの失敗の扱い（設計書6.85）", () => {
  test("置いたあとに確かめられなかったら、別名で作り直さない", async () => {
    // `atomicWriteFile` の path_conflict には2つある。**まだ置いていない**
    // （名前がぶつかった）ときだけ名前をずらしてよく、**置いたあとに
    // 中身を確かめられなかった**ときにずらすと、同じ本文の .md が2つできる
    put(path.join("本文", "第1話.docx"), docxOf("<w:p><w:r><w:t>本文</w:t></w:r></w:p>"));
    const fs = workspace.fs as unknown as {
      rename: (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => Promise<void>;
    };
    const rename = fs.rename;
    fs.rename = async (from, to, options) => {
      await rename(from, to, options);
      // 置いた直後に外のツールが書き換えた体にする
      if (to.fsPath.endsWith(".md")) {
        disk.set(to.fsPath, encoder.encode("外で書き換えられた"));
      }
    };

    const done = await convertDocxToMarkdown(work);

    expect(done).toBe(false);
    // **同じ本文の .md を2つ作らない**
    expect(manuscriptNames().filter((name) => name.endsWith(".md"))).toEqual([
      "第1話.md",
    ]);
    expect(textOf("error")).toContain("第1話.docx");
    expect(textOf("error")).toContain("確かめられませんでした");
  });

  test("変換できなかったものの一覧は、先頭3件＋ほかN件にする", async () => {
    // 何十件も並べると通知が画面を覆う（落としたもの側と同じ揃え方）
    put(path.join("本文", "第0話.docx"), docxOf("<w:p><w:r><w:t>読めた</w:t></w:r></w:p>"));
    for (const index of [1, 2, 3, 4]) {
      put(path.join("本文", `第${index}話.docx`), encoder.encode("これはZIPではない"));
    }

    await convertDocxToMarkdown(work);

    const info = textOf("info");
    expect(info).toContain("4件は変換できませんでした");
    expect(info).toContain("ほか1件");
  });
});
