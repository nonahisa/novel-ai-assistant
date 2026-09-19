import { afterEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { FileSystemError, Uri, window, workspace } from "vscode";
import { importWorkFromZip } from "../../src/features/importWorkFromZip";
// **期待する場所は、製品と同じ組み立て方で作る。** 区切り文字を手で
// 書くと、動かす環境（Windows と そうでないもの）で試験だけが落ちる
import * as paths from "../../src/core/paths";
import type { WorkEntry } from "../../src/models/types";

/**
 * ZIPからの取り込み（設計書6.98）の、書き込みまわり。
 *
 * 読み取りと下書きの決め方は `workZip.test.ts` が見ている。ここで見るのは
 * **どこへ書いたか**と、**すでにあるフォルダーには書かないこと**
 * （実装ルール1・2）の2つである。止まるほうだけを試すと、「いつでも
 * 止まる実装」が満点になるので、**通る道も一緒に確かめる。**
 *
 * ファイルは作らず、覚え書きの上で動かす（作者の原稿の近くで試験を
 * 走らせない）。
 */

const ZIP_PATH = "c:/Downloads/星を継ぐ者たち_20260919.zip";
/** 登録済みの作品の親。ここが書庫になり、作品フォルダーができる */
const LIBRARY = paths.normalize("c:/小説");
const WORK_FOLDER = paths.join(LIBRARY, "星を継ぐ者たち");
const MANUSCRIPT = paths.join(WORK_FOLDER, "本文");
const SETTINGS = paths.join(WORK_FOLDER, "設定");

const ABOUT_TEXT = [
  "【タイトル】",
  "星を継ぐ者たち",
  "",
  "【ジャンル】",
  "異世界ファンタジー",
  "",
  "【キャッチコピー】",
  "教科書の力を見直してみませんか？",
  "",
  "【紹介文】",
  "受験生の少年が、いきなり異世界に転生した。",
  "",
  "【タグ】",
  "- 異世界転生",
  "- チート",
  "",
].join("\n");

const EPISODE_TEXT = [
  "【タイトル】",
  "第1話　転生前夜",
  "",
  "【本文】",
  "夜が更けていく。",
  "",
].join("\n");

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const ZIP_BYTES = zipSync({
  "about.txt": utf8(ABOUT_TEXT),
  "episode_0001.txt": utf8(EPISODE_TEXT),
});

/** 覚え書きの上のファイルシステム。**本物のディスクには触らない** */
class MemoryFs {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();

  constructor(seed: Record<string, Uint8Array>) {
    for (const [name, bytes] of Object.entries(seed)) {
      this.files.set(name, bytes);
    }
  }

  /** 一時ファイル（`.novelai-....tmp`）を除いた、置かれたファイルの名前 */
  placed(): string[] {
    return [...this.files.keys()]
      .filter((name) => !name.includes(".novelai-"))
      .sort();
  }

  text(name: string): string {
    const bytes = this.files.get(name);
    if (!bytes) throw new Error(`${name} が置かれていません。`);
    return new TextDecoder().decode(bytes);
  }

  install(): void {
    workspace.fs = {
      readFile: async (uri: { fsPath: string }) => {
        const bytes = this.files.get(uri.fsPath);
        if (!bytes) throw new FileSystemError(uri.fsPath, "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        this.files.set(uri.fsPath, bytes);
      },
      stat: async (uri: { fsPath: string }) => {
        if (this.files.has(uri.fsPath)) return { type: 1 };
        if (this.directories.has(uri.fsPath)) return { type: 2 };
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      },
      createDirectory: async (uri: { fsPath: string }) => {
        this.directories.add(uri.fsPath);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        if (this.files.has(to.fsPath) && !options?.overwrite) {
          throw new FileSystemError(to.fsPath, "FileExists");
        }
        const bytes = this.files.get(from.fsPath);
        if (!bytes) throw new FileSystemError(from.fsPath, "FileNotFound");
        this.files.delete(from.fsPath);
        this.files.set(to.fsPath, bytes);
      },
      delete: async (uri: { fsPath: string }) => {
        this.files.delete(uri.fsPath);
      },
    } as unknown as typeof workspace.fs;
  }
}

const original = {
  showOpenDialog: window.showOpenDialog,
  showInformationMessage: window.showInformationMessage,
  showWarningMessage: window.showWarningMessage,
  fs: workspace.fs,
};

const warnings: string[] = [];

/** 画面の3つの窓口を差し替える。作者は「取り込む」を押した体にする */
function stubWindow(): void {
  warnings.length = 0;
  window.showOpenDialog = async () => [Uri.file(ZIP_PATH)];
  window.showInformationMessage = (async (
    _message: string,
    ..._items: unknown[]
  ) => "取り込む") as typeof window.showInformationMessage;
  window.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return undefined;
  }) as typeof window.showWarningMessage;
}

function workEntry(): WorkEntry {
  return {
    id: "w1",
    title: "星を継ぐ者たち",
    folderPath: WORK_FOLDER,
    registeredAt: "2026-09-19T00:00:00.000Z",
  };
}

/** 書庫が1つに決まる形（`decideNewWorkHome` が訊かずに決める） */
const WORKS = [{ folderPath: paths.join(LIBRARY, "既にある作品") }];

describe("ZIPから作品を取り込む", () => {
  afterEach(() => {
    window.showOpenDialog = original.showOpenDialog;
    window.showInformationMessage = original.showInformationMessage;
    window.showWarningMessage = original.showWarningMessage;
    workspace.fs = original.fs;
  });

  it("書庫の中に作品フォルダーを作り、原稿を本文フォルダーへ置く", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();
    const registered: Array<{ folderPath: string; title: string }> = [];

    await importWorkFromZip(WORKS, async (folderPath, title) => {
      registered.push({ folderPath, title });
      return workEntry();
    });

    expect(registered).toEqual([
      { folderPath: WORK_FOLDER, title: "星を継ぐ者たち" },
    ]);
    expect(fs.placed()).toContain(paths.join(MANUSCRIPT, "episode_0001.txt"));
    expect(fs.placed()).toContain(paths.join(MANUSCRIPT, "about.txt"));
    // 頭書きごと、ZIPの中身をそのまま置く
    expect(fs.text(paths.join(MANUSCRIPT, "episode_0001.txt"))).toBe(EPISODE_TEXT);
  });

  it("「1作品だと分かっている」と伝えて登録を頼む（書庫か訊かせない）", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();
    const options: unknown[] = [];

    await importWorkFromZip(WORKS, async (_folderPath, _title, given) => {
      options.push(given);
      return workEntry();
    });

    // **作ったのは取り込み自身である**（`本文/` と `設定/` を置いた）。
    // 書庫かもしれないと見に行かせると、作者に間違った既定の選択が出る
    expect(options).toEqual([{ knownSingleWork: true }]);
  });

  it("about.txt のキャッチコピーと紹介文を、紹介文の文書へ下書きする", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    const synopsis = fs.text(paths.join(SETTINGS, "synopsis.md"));
    expect(synopsis).toContain("教科書の力を見直してみませんか？");
    expect(synopsis).toContain("受験生の少年が、いきなり異世界に転生した。");
  });

  it("about.txt のジャンルとタグを、プロットの空いている節へ下書きする", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    const plot = fs.text(paths.join(SETTINGS, "plot.md"));
    expect(plot).toContain("異世界ファンタジー");
    expect(plot).toContain("異世界転生");
    expect(plot).toContain("チート");
  });

  it("紹介文の文書がすでにあれば、上書きしない", async () => {
    const fs = new MemoryFs({
      [ZIP_PATH]: ZIP_BYTES,
      [paths.join(SETTINGS, "synopsis.md")]: utf8("作者が書いた紹介文\n"),
    });
    fs.install();
    stubWindow();

    // 作品フォルダーそのものは「まだ無い」ことにして、取り込みは通す
    // （`設定/` の中だけが先に在る、という作りにくい形をわざと作る）
    await importWorkFromZip(WORKS, async () => workEntry());

    expect(fs.text(paths.join(SETTINGS, "synopsis.md"))).toBe(
      "作者が書いた紹介文\n"
    );
  });

  it("同じ名前のフォルダーがすでにあれば、理由を出して止まる", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.directories.add(WORK_FOLDER);
    fs.install();
    stubWindow();
    let registered = 0;

    await importWorkFromZip(WORKS, async () => {
      registered += 1;
      return undefined;
    });

    expect(warnings.join("\n")).toContain("すでにあります");
    expect(registered, "登録まで進んではいけない").toBe(0);
    // ZIPのほかには1件も置いていない
    expect(fs.placed()).toEqual([ZIP_PATH]);
  });

  it("ZIPを選ばずに閉じたら、何も起きない", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();
    window.showOpenDialog = async () => undefined;

    await importWorkFromZip(WORKS, async () => workEntry());

    expect(fs.placed()).toEqual([ZIP_PATH]);
  });

  it("危ないファイル名のZIPは、1件も置かずに断る", async () => {
    const dangerous = zipSync({
      "episode_0001.txt": utf8(EPISODE_TEXT),
      "../外へ.txt": utf8("よそへ書きます"),
    });
    const fs = new MemoryFs({ [ZIP_PATH]: dangerous });
    fs.install();
    stubWindow();
    let registered = 0;

    await importWorkFromZip(WORKS, async () => {
      registered += 1;
      return undefined;
    });

    expect(warnings.join("\n")).toContain("外を指すファイル名");
    expect(registered).toBe(0);
    expect(fs.placed()).toEqual([ZIP_PATH]);
  });
});
