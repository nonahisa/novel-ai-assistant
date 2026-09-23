import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  stat as nodeStat,
  readdir as nodeReaddir,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";
import {
  describeUnregistered,
  findUnregisteredWorks,
  foldNotified,
  libraryRootsOf,
  unnotifiedFolders,
  type FoundWork,
} from "../../../src/core/unregisteredWorks";
import { normalizeForComparison } from "../../../src/core/pathText";

/**
 * 書庫にあるのに登録されていない作品を拾う（設計書6.97.4）。
 *
 * **踏んだのは実機である**（2026-09-19）。なろうのバックアップから作品を
 * 書庫へ置いたあと、登録する道が「フォルダから追加」しかなく、OSの
 * フォルダー選びを6回潜ることになった。別の機械で `git pull` したときも、
 * **ファイルはあるのに、その機械では登録されていない**状態になる。
 *
 * **実際のフォルダーを作って試す。** 判定はファイルの有無だけで決まるので、
 * 作り物のデータで確かめると `stat` の使い方の間違いを見逃す
 * （`workCollection.test.ts` と同じ理由）。作者の作品フォルダーは読まない。
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
      const entries = await nodeReaddir(uri.fsPath, { withFileTypes: true });
      // **種別まで本物に合わせる。** すべてファイルとして返すと、
      // 話数の数え上げがフォルダーまで数えてしまうのに気づけない
      return entries.map((entry) => [
        entry.name,
        entry.isDirectory() ? FileType.Directory : FileType.File,
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileSystemError("見つかりません", "FileNotFound");
      }
      throw error;
    }
  },
} as never;

let library: string;
/** 登録済みの作品 */
let registered: string;

async function makeWork(
  name: string,
  options: { config?: boolean; episodes?: number } = {}
): Promise<string> {
  const folder = path.join(library, name);
  await mkdir(path.join(folder, "本文"), { recursive: true });
  if (options.config) {
    await mkdir(path.join(folder, ".aiwriter"), { recursive: true });
    await writeFile(
      path.join(folder, ".aiwriter", "config.json"),
      JSON.stringify({ workTitle: name }),
      "utf8"
    );
  }
  for (let i = 1; i <= (options.episodes ?? 1); i++) {
    await writeFile(
      path.join(folder, "本文", `${String(i).padStart(3, "0")}.txt`),
      "本文",
      "utf8"
    );
  }
  return folder;
}

beforeAll(async () => {
  library = await mkdtemp(path.join(os.tmpdir(), "novelai-unregistered-"));

  registered = await makeWork("登録済みの作品", { config: true, episodes: 2 });
  // 未登録・設定ファイルあり（なろうのバックアップから置いた形）
  await makeWork("肉片とラジオと心霊現象", { config: true, episodes: 4 });
  // 未登録・設定ファイルなし（手でフォルダーを並べただけの形）
  await makeWork("手で置いた作品", { episodes: 3 });

  // 作品ではないフォルダー。拾ってはいけない
  await mkdir(path.join(library, "資料"), { recursive: true });
  await writeFile(path.join(library, "資料", "README.md"), "めも", "utf8");

  // 裏方のフォルダー。中に作品らしい形があっても出さない
  await mkdir(path.join(library, ".git", "本文"), { recursive: true });
});

afterAll(async () => {
  await rm(library, { recursive: true, force: true });
});

describe("書庫の根を割り出す", () => {
  it("登録済み作品の親フォルダーが書庫になる", async () => {
    const roots = await libraryRootsOf([{ folderPath: registered }]);

    expect(roots.map(normalizeForComparison)).toEqual([
      normalizeForComparison(library),
    ]);
  });

  it("gitの根が作品の上にあれば、そこも探す", async () => {
    const outer = path.dirname(library);
    const roots = await libraryRootsOf([{ folderPath: registered }], async () =>
      outer
    );

    expect(roots.map(normalizeForComparison)).toContain(
      normalizeForComparison(outer)
    );
  });

  it("gitの根が作品そのものなら、足さない（上は親が受け持つ）", async () => {
    const roots = await libraryRootsOf(
      [{ folderPath: registered }],
      async () => registered
    );

    expect(roots.map(normalizeForComparison)).toEqual([
      normalizeForComparison(library),
    ]);
  });
});

describe("書庫の未登録の作品を拾う", () => {
  it("未登録の作品だけを、題と話数つきで返す", async () => {
    const found = await findUnregisteredWorks([{ folderPath: registered }]);

    expect(found.map((work) => work.title)).toEqual([
      "手で置いた作品",
      "肉片とラジオと心霊現象",
    ]);

    const backup = found.find(
      (work) => work.title === "肉片とラジオと心霊現象"
    );
    expect(backup?.hasConfig).toBe(true);
    expect(backup?.episodeCount).toBe(4);

    const byHand = found.find((work) => work.title === "手で置いた作品");
    expect(byHand?.hasConfig).toBe(false);
    expect(byHand?.episodeCount).toBe(3);
  });

  it("登録済みの作品は出さない", async () => {
    const found = await findUnregisteredWorks([{ folderPath: registered }]);

    expect(found.map((work) => work.title)).not.toContain("登録済みの作品");
  });

  it("裏方のフォルダーと、作品でないフォルダーは出さない", async () => {
    const found = await findUnregisteredWorks([{ folderPath: registered }]);
    const titles = found.map((work) => work.title);

    expect(titles).not.toContain(".git");
    expect(titles).not.toContain("資料");
  });

  it("作品フォルダーの中は覗かない（「本文」を作品にしない）", async () => {
    // **書庫の根だけを探す。** 作品フォルダーを根にすると、その直下の
    // 「本文」が話数ファイルを持っているせいで作品に見えてしまう
    const found = await findUnregisteredWorks([{ folderPath: registered }]);

    expect(found.map((work) => work.title)).not.toContain("本文");
  });

  it("同じ作品を二重に出さない（書庫の根が複数あっても）", async () => {
    const found = await findUnregisteredWorks(
      [{ folderPath: registered }],
      // gitの根として、書庫そのものをもう一度返す
      { repoRootOf: async () => library }
    );

    expect(found.map((work) => work.title)).toEqual([
      "手で置いた作品",
      "肉片とラジオと心霊現象",
    ]);
  });

  it("登録済みの作品が1つも無ければ、探しようがない", async () => {
    expect(await findUnregisteredWorks([])).toEqual([]);
  });
});

describe("起動したときの知らせを畳む", () => {
  const works: FoundWork[] = [
    { folderPath: "C:/novel/A", title: "A", hasConfig: true, episodeCount: 1 },
    { folderPath: "C:/novel/B", title: "B", hasConfig: false, episodeCount: 2 },
  ];

  it("まだ知らせていないものがあれば、知らせる", () => {
    expect(unnotifiedFolders(works, []).map((w) => w.title)).toEqual([
      "A",
      "B",
    ]);
  });

  it("一度知らせたものは、次の起動では黙る", () => {
    const notified = foldNotified(works);

    expect(unnotifiedFolders(works, notified)).toEqual([]);
  });

  it("あとから増えた作品は、もう一度知らせる", () => {
    const notified = foldNotified([works[0]]);

    expect(unnotifiedFolders(works, notified).map((w) => w.title)).toEqual([
      "B",
    ]);
  });

  it("見つからなくなったものは覚えから外す（登録されたら忘れる）", () => {
    // 覚えを際限なく増やさない。次に覚えるのは「いま見つかっている分」だけ
    expect(foldNotified([works[0]])).toEqual([
      normalizeForComparison("C:/novel/A"),
    ]);
  });

  it("知らせの文には、件数と題が入る", () => {
    const message = describeUnregistered(works);

    expect(message).toContain("2件");
    expect(message).toContain("A");
    expect(message).toContain("B");
  });

  it("多いときは題を並べきらない", () => {
    const many: FoundWork[] = ["あ", "い", "う", "え", "お"].map((title) => ({
      folderPath: `C:/novel/${title}`,
      title,
      hasConfig: true,
      episodeCount: 1,
    }));

    const message = describeUnregistered(many);

    expect(message).toContain("5件");
    expect(message).toContain("ほか2件");
  });
});
