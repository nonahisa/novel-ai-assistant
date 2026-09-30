import { describe, expect, test } from "vitest";
import {
  resolveManuscriptDirAsync,
  resolveManuscriptDirSync,
  type EntryKind,
  type Listing,
  type ManuscriptPaths,
} from "../../../src/core/manuscriptFolderRule";

/**
 * 本文の置き場の決め方（机のPCで第1話が見えなかった件）。
 *
 * 決め方は1つで、拡張機能（非同期の読み口）と MCP（同期の `fs`）が
 * 同じものを通る。**両方の走らせ役が同じ答えを返すこと**も押さえる。
 */
const ROOT = "/works/作品";
const P: ManuscriptPaths = {
  root: ROOT,
  manuscript: `${ROOT}/本文`,
  settings: `${ROOT}/設定`,
};

/**
 * 作り物のフォルダー。`files` はファイルの相対パス、`dirs` は中身の無い
 * フォルダーの相対パス（git が運ばない、登録した機械にだけ残る形）。
 */
function tree(files: readonly string[], dirs: readonly string[] = []) {
  const allFiles = files.map((rel) => `${ROOT}/${rel}`);
  const allDirs = dirs.map((rel) => `${ROOT}/${rel}`);
  const entries = [...allFiles, ...allDirs];
  const isDir = (at: string): boolean =>
    at === ROOT ||
    allDirs.includes(at) ||
    entries.some((entry) => entry.startsWith(`${at}/`));
  // **区切りを「/」へ揃えてから見る。** 決め方は `pathText.join` で場所を
  // 組むので、Windows で走らせると「\」が混ざる
  const slash = (at: string): string => at.replace(/\\/g, "/");
  const kind = (raw: string): EntryKind | "missing" => {
    const at = slash(raw);
    return allFiles.includes(at) ? "file" : isDir(at) ? "directory" : "missing";
  };
  const list = (raw: string): Listing | undefined => {
    const at = slash(raw);
    if (!isDir(at)) return undefined;
    const seen = new Map<string, EntryKind>();
    for (const entry of entries) {
      if (!entry.startsWith(`${at}/`)) continue;
      const [head, ...tail] = entry.slice(at.length + 1).split("/");
      const isFile = tail.length === 0 && allFiles.includes(entry);
      if (!seen.has(head) || !isFile) seen.set(head, isFile ? "file" : "directory");
    }
    return [...seen.entries()];
  };
  return { kind, list };
}

/** 両方の走らせ役で決めて、答えがそろっていることを確かめてから返す */
async function decide(io: ReturnType<typeof tree>): Promise<string> {
  const sync = resolveManuscriptDirSync(P, io);
  const viaAsync = await resolveManuscriptDirAsync(P, {
    kind: async (at) => io.kind(at),
    list: async (at) => io.list(at),
  });
  expect(viaAsync).toBe(sync);
  return sync;
}

describe("本文の置き場の決め方", () => {
  test("本文フォルダーが無ければ直下", async () => {
    expect(await decide(tree(["001.txt"]))).toBe(ROOT);
  });

  test("空の本文フォルダーがあっても、直下に原稿があれば直下（フォルダーが無いときと同じ）", async () => {
    expect(await decide(tree(["001.txt", "002.txt"], ["本文"]))).toBe(ROOT);
  });

  test("本文フォルダーに原稿が1件でもあれば本文フォルダー", async () => {
    expect(await decide(tree(["本文/001.txt", "下書き.txt"]))).toBe(P.manuscript);
  });

  test("本文フォルダーの原稿が章フォルダーの中だけでも本文フォルダー", async () => {
    expect(await decide(tree(["本文/第一章/001.txt", "下書き.txt"]))).toBe(
      P.manuscript
    );
  });

  test("どちらにも原稿が無ければ本文フォルダー（登録したばかりの作品）", async () => {
    expect(await decide(tree(["設定/人物.md"], ["本文"]))).toBe(P.manuscript);
  });

  test("直下が README・AI への指示書だけなら、原稿とみなさず本文フォルダー", async () => {
    expect(
      await decide(tree(["README.md", "AGENTS.md", "LICENSE.txt"], ["本文"]))
    ).toBe(P.manuscript);
  });

  test("本文フォルダーの中が原稿でないもの（画像・競合の退避）だけなら、空とみなす", async () => {
    expect(
      await decide(
        tree(["本文/表紙.png", "本文/001.conflict-origin_main.txt", "001.txt"])
      )
    ).toBe(ROOT);
  });

  test("設定フォルダーの中の .md は、直下の原稿に数えない", async () => {
    expect(await decide(tree(["設定/メモ/案.md"], ["本文"]))).toBe(P.manuscript);
  });

  test("本文という名前のファイルなら直下", async () => {
    expect(await decide(tree(["本文", "001.txt"]))).toBe(ROOT);
  });

  test("「見つからない」以外の失敗は投げる（直下へ黙って切り替えない）", async () => {
    const denied = new Error("権限がありません");
    const io = {
      kind: (): EntryKind | "missing" => {
        throw denied;
      },
      list: (): Listing | undefined => undefined,
    };
    expect(() => resolveManuscriptDirSync(P, io)).toThrow(denied);
    await expect(
      resolveManuscriptDirAsync(P, {
        kind: async () => io.kind(),
        list: async () => io.list(),
      })
    ).rejects.toBe(denied);
  });

  test("原稿を見つけたら、それ以上フォルダーを覗かない", async () => {
    const io = tree(["本文/001.txt", "本文/第一章/002.txt"]);
    const listed: string[] = [];
    resolveManuscriptDirSync(P, {
      kind: io.kind,
      list: (at) => {
        listed.push(at);
        return io.list(at);
      },
    });
    expect(listed.map((at) => at.replace(/\\/g, "/"))).toEqual([P.manuscript]);
  });
});
