import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  stat as nodeStat,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";
import {
  scanCollection,
  looksLikeWork,
  describeScan,
} from "../../../src/core/workCollection";

/**
 * 書庫の走査。
 *
 * **実際のフォルダーを作って試す。** 判定はファイルの有無だけで決まるので、
 * 作り物のデータで確かめると、`stat` の使い方を間違えていても通ってしまう。
 *
 * `workCollection.ts` は `vscode.workspace.fs` 経由になった（ブラウザ版の
 * VS Codeには `node:fs` が無いため。設計書5.8）。ここでは、その
 * `workspace.fs` を実ディスクの `node:fs` へ橋渡しする。**中身をMapで
 * 作った偽物にはしない。** 偽物にすると、上の「作り物のデータでは
 * `stat` の間違いを見逃す」という当初の目的が失われる。
 */

workspace.fs = {
  stat: async (uri: { fsPath: string }) => {
    try {
      const s = await nodeStat(uri.fsPath);
      return { type: s.isDirectory() ? FileType.Directory : FileType.File };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileSystemError("見つかりません", "FileNotFound");
      }
      throw error;
    }
  },
  readDirectory: async (uri: { fsPath: string }) => {
    try {
      const names = await nodeReaddir(uri.fsPath);
      return names.map((name) => [name, 1]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileSystemError("見つかりません", "FileNotFound");
      }
      throw error;
    }
  },
  // 作品の設定ファイル（本文・設定の置き場）を読むため
  readFile: async (uri: { fsPath: string }) => {
    try {
      return new Uint8Array(await nodeReadFile(uri.fsPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileSystemError("見つかりません", "FileNotFound");
      }
      throw error;
    }
  },
} as never;

let root: string;

async function makeWork(
  parent: string,
  name: string,
  options: { config?: boolean; manuscript?: boolean; settings?: boolean } = {}
): Promise<string> {
  const folder = path.join(parent, name);
  await mkdir(folder, { recursive: true });
  if (options.config) {
    await mkdir(path.join(folder, ".aiwriter"), { recursive: true });
    await writeFile(
      path.join(folder, ".aiwriter", "config.json"),
      JSON.stringify({ workTitle: name }),
      "utf-8"
    );
  }
  if (options.manuscript) {
    await mkdir(path.join(folder, "本文"), { recursive: true });
  }
  if (options.settings) {
    await mkdir(path.join(folder, "設定"), { recursive: true });
  }
  return folder;
}

const none = () => false;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "novelai-collection-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("looksLikeWork", () => {
  it("設定ファイルがあれば作品と分かる", async () => {
    const folder = await makeWork(root, "設定ありの作品", { config: true });
    expect(await looksLikeWork(folder)).toEqual({
      isWork: true,
      hasConfig: true,
    });
  });

  it("本文フォルダーだけでも作品と見なす", async () => {
    // 作者が手で並べたフォルダーには設定ファイルが無い
    const folder = await makeWork(root, "手で並べた作品", { manuscript: true });
    expect(await looksLikeWork(folder)).toEqual({
      isWork: true,
      hasConfig: false,
    });
  });

  it("設定フォルダーだけでも作品と見なす", async () => {
    // 本文をまだ書いていない、プロットだけの作品がありうる
    const folder = await makeWork(root, "設定だけの作品", { settings: true });
    expect((await looksLikeWork(folder)).isWork).toBe(true);
  });

  it("どちらも無ければ作品ではない", async () => {
    const folder = await makeWork(root, "ただのフォルダー");
    expect((await looksLikeWork(folder)).isWork).toBe(false);
  });

  /**
   * **作者の運用がこの形だった**（2026-08-22、実機で判明）。
   *
   * 「本文」フォルダを作らず、作品フォルダーへ直に `001.txt` を置く。
   * ここを見ていなかったため、**書庫の中の作品が1つも作品と認識されず**、
   * 書庫まるごとが1作品として登録された（328ファイル・996,040字という、
   * 複数作品の話が混ざった一覧になった）。
   */
  it("話数ファイルが直下に並んでいれば作品と見なす", async () => {
    const folder = path.join(root, "直に話数を置く作品");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "001.txt"), "本文", "utf-8");
    await writeFile(path.join(folder, "002.txt"), "本文", "utf-8");
    expect((await looksLikeWork(folder)).isWork).toBe(true);
  });

  it("プロローグだけでも作品と見なす", async () => {
    const folder = path.join(root, "プロローグだけの作品");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "プロローグ.txt"), "本文", "utf-8");
    expect((await looksLikeWork(folder)).isWork).toBe(true);
  });

  it("話数として読めないファイルだけなら作品ではない", async () => {
    // **書庫そのものを作品と誤認しない。**
    // 書庫の直下にも README.md や characters.json は置かれる
    const folder = path.join(root, "書庫らしい置き場");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "README.md"), "説明", "utf-8");
    await writeFile(path.join(folder, "characters.json"), "{}", "utf-8");
    await writeFile(path.join(folder, "プロンプト雛形.txt"), "雛形", "utf-8");
    expect((await looksLikeWork(folder)).isWork).toBe(false);
  });
});

describe("scanCollection", () => {
  let collection: string;

  beforeAll(async () => {
    collection = path.join(root, "書庫");
    await mkdir(collection, { recursive: true });
    await makeWork(collection, "いじめられっ子", {
      config: true,
      manuscript: true,
    });
    await makeWork(collection, "教科書チート", { manuscript: true });
    await makeWork(collection, "あ行の作品", { settings: true });
    // 作品ではないもの
    await makeWork(collection, "メモ");
    await mkdir(path.join(collection, ".git"), { recursive: true });
    await mkdir(path.join(collection, ".novelai-recovery"), {
      recursive: true,
    });
  });

  it("直下の作品だけを見つける", async () => {
    const scan = await scanCollection(collection, none);
    expect(scan.kind).toBe("collection");
    if (scan.kind !== "collection") return;
    expect(scan.works.map((w) => w.title)).toEqual([
      "あ行の作品",
      "いじめられっ子",
      "教科書チート",
    ]);
  });

  it("作品ではないフォルダーと隠しフォルダーを拾わない", async () => {
    const scan = await scanCollection(collection, none);
    if (scan.kind !== "collection") throw new Error("書庫のはず");
    const titles = scan.works.map((w) => w.title);
    expect(titles).not.toContain("メモ");
    expect(titles).not.toContain(".git");
    expect(titles).not.toContain(".novelai-recovery");
  });

  it("設定ファイルの有無を伝える", async () => {
    const scan = await scanCollection(collection, none);
    if (scan.kind !== "collection") throw new Error("書庫のはず");
    const byTitle = new Map(scan.works.map((w) => [w.title, w]));
    expect(byTitle.get("いじめられっ子")?.hasConfig).toBe(true);
    expect(byTitle.get("教科書チート")?.hasConfig).toBe(false);
  });

  it("登録済みのものに印を付ける", async () => {
    const registered = path.normalize(path.join(collection, "教科書チート"));
    const scan = await scanCollection(
      collection,
      (folder) => folder === registered
    );
    if (scan.kind !== "collection") throw new Error("書庫のはず");
    const byTitle = new Map(scan.works.map((w) => [w.title, w]));
    expect(byTitle.get("教科書チート")?.alreadyRegistered).toBe(true);
    expect(byTitle.get("いじめられっ子")?.alreadyRegistered).toBe(false);
  });

  it("作品そのものを指されたら書庫とは言わない", async () => {
    // ここで分けないと、作品の中の「本文」「設定」を作品として並べてしまう
    const work = path.join(collection, "いじめられっ子");
    expect((await scanCollection(work, none)).kind).toBe("single_work");
  });

  /**
   * **作者の `HisasNovels` がこの形だった**（2026-08-22、実機で判明）。
   *
   * 書庫の直下に `.aiwriter/config.json` が残っていた（書庫の仕組みが
   * できる前に、その全体を1作品として登録した名残）。
   *
   * 以前は「自分が作品なら中を見ない」としていたため、**書庫なのに
   * 1作品と判定され、中の作品を登録する道に入れなかった。**
   * 機械には決められないので、両方の性質があることを伝えて作者に選ばせる。
   */
  it("自分も作品に見えて、中にも作品があれば、どちらとも言わない", async () => {
    const both = path.join(root, "設定ファイルが残った書庫");
    await mkdir(both, { recursive: true });
    // 過去の登録の名残
    await mkdir(path.join(both, ".aiwriter"), { recursive: true });
    await writeFile(
      path.join(both, ".aiwriter", "config.json"),
      JSON.stringify({ workTitle: "むかしの登録" }),
      "utf-8"
    );
    // 中には作品が並んでいる
    await makeWork(both, "作品A", { manuscript: true });
    await makeWork(both, "作品B", { settings: true });

    const scan = await scanCollection(both, none);
    expect(scan.kind).toBe("work_with_children");
    if (scan.kind !== "work_with_children") return;
    expect(scan.works.map((w) => w.title)).toEqual(["作品A", "作品B"]);
  });

  it("自分が作品で、中に作品が無ければ、これまでどおり1作品", async () => {
    // 上を足したことで、ふつうの作品の判定が変わっていないこと
    const plain = path.join(root, "ふつうの作品");
    await makeWork(root, "ふつうの作品", { config: true, manuscript: true });
    expect((await scanCollection(plain, none)).kind).toBe("single_work");
  });

  /**
   * **ふつうの作品を登録し直すたびに問われていた**（2026-09-26、統合テストを
   * 書いていた担当が見つけた）。
   *
   * 作品の本文フォルダーに `001.txt` があると、本文フォルダー自身が
   * 「話数ファイルが直下に並んだ作品」に見え、`work_with_children` になっていた。
   * 「中の1件を登録する」を選ぶと、本文フォルダーが別の作品として登録される。
   */
  describe("作品の構成に含まれる置き場を、子の作品に数えない", () => {
    async function writeConfig(
      folder: string,
      dirs: { manuscriptDir?: string; settingsDir?: string } = {}
    ): Promise<void> {
      await mkdir(path.join(folder, ".aiwriter"), { recursive: true });
      await writeFile(
        path.join(folder, ".aiwriter", "config.json"),
        JSON.stringify({
          schemaVersion: "0.1",
          workTitle: path.basename(folder),
          manuscriptDir: dirs.manuscriptDir ?? "本文",
          settingsDir: dirs.settingsDir ?? "設定",
          createdAt: "2026-09-26T00:00:00.000Z",
        }),
        "utf-8"
      );
    }

    it("本文フォルダーに話がある作品は、1作品と言う", async () => {
      const work = path.join(root, "本文に話がある作品");
      await mkdir(path.join(work, "本文"), { recursive: true });
      await mkdir(path.join(work, "設定"), { recursive: true });
      await writeConfig(work);
      await writeFile(path.join(work, "本文", "001.txt"), "本文", "utf-8");
      await writeFile(path.join(work, "本文", "002.txt"), "本文", "utf-8");
      // 設定フォルダーにも話の名前に見えるファイルが置かれることがある
      await writeFile(path.join(work, "設定", "プロローグ.md"), "案", "utf-8");

      expect((await scanCollection(work, none)).kind).toBe("single_work");
    });

    it("設定ファイルが無くても、本文フォルダーを子の作品にしない", async () => {
      // 作者が手で並べた作品（本文フォルダーがあるので作品と見なされる）
      const work = path.join(root, "手で並べた話のある作品");
      await mkdir(path.join(work, "本文"), { recursive: true });
      await writeFile(path.join(work, "本文", "001.txt"), "本文", "utf-8");

      expect((await scanCollection(work, none)).kind).toBe("single_work");
    });

    it("本文フォルダーの名前を変えた作品は、設定ファイルの指す場所で見る", async () => {
      // 名前の決め打ちだけでは「原稿」を子の作品と取り違える
      const work = path.join(root, "名前を変えた作品");
      await mkdir(path.join(work, "原稿"), { recursive: true });
      await mkdir(path.join(work, "資料"), { recursive: true });
      await writeConfig(work, { manuscriptDir: "原稿", settingsDir: "資料" });
      await writeFile(path.join(work, "原稿", "001.txt"), "本文", "utf-8");
      await writeFile(path.join(work, "資料", "エピローグ.md"), "案", "utf-8");

      expect((await scanCollection(work, none)).kind).toBe("single_work");
    });

    it("本文を深い場所に置いた作品は、その入り口のフォルダーを外す", async () => {
      const work = path.join(root, "深い本文の作品");
      await mkdir(path.join(work, "原稿", "本編"), { recursive: true });
      await writeConfig(work, { manuscriptDir: "原稿/本編" });
      await writeFile(path.join(work, "原稿", "本編", "001.txt"), "本文", "utf-8");
      // 入り口の「原稿」に、あとがきの話を直に置いている
      await writeFile(path.join(work, "原稿", "001.txt"), "本文", "utf-8");

      expect((await scanCollection(work, none)).kind).toBe("single_work");
    });

    it("作品の中に別の作品を入れていれば、これまでどおり問う", async () => {
      // 本当に入れ子にしている形は、機械には決められない（5.7.6）
      const work = path.join(root, "外伝を抱えた作品");
      await mkdir(path.join(work, "本文"), { recursive: true });
      await writeConfig(work);
      await writeFile(path.join(work, "本文", "001.txt"), "本文", "utf-8");
      await makeWork(work, "外伝", { config: true, manuscript: true });

      const scan = await scanCollection(work, none);
      expect(scan.kind).toBe("work_with_children");
      if (scan.kind !== "work_with_children") return;
      // 本文フォルダーは並べない
      expect(scan.works.map((w) => w.title)).toEqual(["外伝"]);
    });
  });

  it("作品が無ければその旨を返す", async () => {
    const empty = path.join(root, "空の書庫");
    await mkdir(empty, { recursive: true });
    expect((await scanCollection(empty, none)).kind).toBe("no_works");
  });

  it("読めないフォルダーは理由を返す", async () => {
    const missing = path.join(root, "存在しない");
    const scan = await scanCollection(missing, none);
    expect(scan.kind).toBe("unreadable");
  });
});

describe("describeScan", () => {
  it("作品そのものだったとき、次にどうすればよいか言う", () => {
    const text = describeScan({ kind: "single_work" }, "C:/小説/いじめられっ子");
    expect(text).toContain("いじめられっ子");
    expect(text).toContain("作品を追加");
  });

  it("見つからないとき、探している形を伝える", () => {
    const text = describeScan({ kind: "no_works" }, "C:/小説/空");
    expect(text).toContain("本文");
    expect(text).toContain("設定");
  });

  it("見つかったら件数を言う", () => {
    const text = describeScan(
      {
        kind: "collection",
        works: [
          {
            folderPath: "a",
            title: "a",
            hasConfig: true,
            alreadyRegistered: false,
          },
        ],
      },
      "C:/小説/書庫"
    );
    expect(text).toContain("1件");
  });
});
