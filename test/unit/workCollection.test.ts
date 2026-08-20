import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  scanCollection,
  looksLikeWork,
  describeScan,
} from "../../src/core/workCollection";

/**
 * 作品集の走査。
 *
 * **実際のフォルダーを作って試す。** 判定はファイルの有無だけで決まるので、
 * 作り物のデータで確かめると、`stat` の使い方を間違えていても通ってしまう。
 */

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
});

describe("scanCollection", () => {
  let collection: string;

  beforeAll(async () => {
    collection = path.join(root, "作品集");
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
    if (scan.kind !== "collection") throw new Error("作品集のはず");
    const titles = scan.works.map((w) => w.title);
    expect(titles).not.toContain("メモ");
    expect(titles).not.toContain(".git");
    expect(titles).not.toContain(".novelai-recovery");
  });

  it("設定ファイルの有無を伝える", async () => {
    const scan = await scanCollection(collection, none);
    if (scan.kind !== "collection") throw new Error("作品集のはず");
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
    if (scan.kind !== "collection") throw new Error("作品集のはず");
    const byTitle = new Map(scan.works.map((w) => [w.title, w]));
    expect(byTitle.get("教科書チート")?.alreadyRegistered).toBe(true);
    expect(byTitle.get("いじめられっ子")?.alreadyRegistered).toBe(false);
  });

  it("作品そのものを指されたら作品集とは言わない", async () => {
    // ここで分けないと、作品の中の「本文」「設定」を作品として並べてしまう
    const work = path.join(collection, "いじめられっ子");
    expect((await scanCollection(work, none)).kind).toBe("single_work");
  });

  it("作品が無ければその旨を返す", async () => {
    const empty = path.join(root, "空の作品集");
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
      "C:/小説/作品集"
    );
    expect(text).toContain("1件");
  });
});
