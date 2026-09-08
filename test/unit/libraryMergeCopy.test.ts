import { beforeEach, describe, expect, it } from "vitest";
import {
  mergeOne,
  reregister,
  type MergeOutcome,
} from "../../src/features/mergeIntoLibrary";
import type { MergePlan } from "../../src/core/libraryMerge";
import type { WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";
import { FileType, workspace } from "./support/vscodeStub";

/**
 * 書庫へまとめ直すときの、**写す側と登録簿の側**（設計書5.7.10）。
 *
 * どこへ写すかの判定は `libraryMerge.test.ts` が見ている。こちらで見るのは
 * 「実際に写したあと、何がどうなっているか」——**文字コードと改行が
 * 元のままか**、**途中で取りやめたときに元が無事か**、**作品一覧の指す先が
 * 新しい場所へ移り、古い登録が外れるか**の3つである。
 *
 * フォルダー選択の画面は通らない（`mergeOne` と `reregister` を直に呼ぶ）。
 * 「実行の項目がメニューに出るか」は実機に残る。
 */

/**
 * 作り物のファイルシステム。**中身はバイト列のまま持つ**
 * （文字列にすると、この試験で見たいことが見えなくなる）。
 */
const files = new Map<string, Uint8Array>();

/**
 * 道を1つの形へ揃える。
 *
 * `paths.join` は手元では `\` で繋ぎ、スタブの `Uri.file` は
 * ドライブ文字を小文字にする。**書いた側と読んだ側で形が違うと、
 * 実物では同じファイルなのに別物として扱われてしまう。**
 */
function key(location: string): string {
  return location
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
}

function put(location: string, bytes: Uint8Array): void {
  files.set(key(location), bytes);
}

function has(location: string): boolean {
  return files.has(key(location));
}

/** その道の直下にあるものを並べる（`readDirectory` の作り物） */
function childrenOf(dir: string): [string, FileType][] {
  const prefix = `${key(dir)}/`;
  const names = new Map<string, FileType>();
  for (const full of files.keys()) {
    if (!full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    const cut = rest.indexOf("/");
    if (cut < 0) names.set(rest, FileType.File);
    else names.set(rest.slice(0, cut), FileType.Directory);
  }
  return [...names.entries()];
}

beforeEach(() => {
  files.clear();
  workspace.fs = {
    readDirectory: async (uri: { fsPath: string }) => {
      const found = childrenOf(uri.fsPath);
      // 実物は、無いフォルダーで例外を投げる（`collectFiles` はそれで止まる）
      if (found.length === 0) throw new Error("見つかりません");
      return found;
    },
    stat: async (uri: { fsPath: string }) => {
      const target = key(uri.fsPath);
      const exists =
        files.has(target) ||
        [...files.keys()].some((full) => full.startsWith(`${target}/`));
      if (!exists) throw new Error("見つかりません");
      return { type: FileType.File, ctime: 0, mtime: 0, size: 0 };
    },
    createDirectory: async () => undefined,
    readFile: async (uri: { fsPath: string }) => {
      const bytes = files.get(key(uri.fsPath));
      if (!bytes) throw new Error("見つかりません");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      files.set(key(uri.fsPath), bytes);
    },
  } as never;
});

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-08-22T00:00:00.000Z",
};

const plan: MergePlan = {
  work,
  destination: "C:/書庫/いじめられっ子",
  folderName: "いじめられっ子",
};

/** 取りやめない札 */
const running = { isCancellationRequested: false } as never;

/**
 * Shift_JIS・CRLF の原稿（実データに近い形）。
 *
 * **文字列にして写していないか**を見たいので、UTF-8 では表せない並びを使う。
 * 「あ」＝0x82 0xA0、「い」＝0x82 0xA2。
 */
const SJIS_CRLF = new Uint8Array([
  0x82, 0xa0, 0x0d, 0x0a, 0x82, 0xa2, 0x0d, 0x0a,
]);

describe("写したものの中身", () => {
  it("文字コードも改行も、1バイトも変わらずに写る（実機確認リスト A-8 の代わり）", async () => {
    // **文字列へ直して書き戻すと、ここで UTF-8・LF に化ける。**
    // 作者の原稿は投稿サイトからのダウンロードで Shift_JIS のことがある
    put("C:/小説/いじめられっ子/本文/001.txt", SJIS_CRLF);

    const outcome = await mergeOne(plan, running);

    expect(outcome.ok).toBe(true);
    expect([
      ...files.get(key("C:/書庫/いじめられっ子/本文/001.txt"))!,
    ]).toEqual([...SJIS_CRLF]);
  });

  it("元のファイルはそのまま残る（写すだけで、動かさない）（実機確認リスト A-8 の代わり）", async () => {
    put("C:/小説/いじめられっ子/本文/001.txt", SJIS_CRLF);

    await mergeOne(plan, running);

    expect(has("C:/小説/いじめられっ子/本文/001.txt")).toBe(true);
  });

  it("フォルダーの形をたたんで写す（設定資料も同じ場所へ）（実機確認リスト A-8 の代わり）", async () => {
    put("C:/小説/いじめられっ子/本文/001.txt", new Uint8Array([1]));
    put("C:/小説/いじめられっ子/設定/characters/太志.json", new Uint8Array([2]));

    const outcome = await mergeOne(plan, running);

    expect(outcome.ok).toBe(true);
    expect(has("C:/書庫/いじめられっ子/設定/characters/太志.json")).toBe(
      true
    );
  });
});

describe("途中で取りやめたとき", () => {
  it("そこまで写した分だけが残り、続きは写さない（実機確認リスト A-8 の代わり）", async () => {
    for (const name of ["001.txt", "002.txt", "003.txt"]) {
      put(`C:/小説/いじめられっ子/本文/${name}`, new Uint8Array([1]));
    }
    // 1件目を写した直後に押された、という形にする
    let written = 0;
    const token = {
      get isCancellationRequested(): boolean {
        return written >= 1;
      },
    } as never;
    const write = workspace.fs.writeFile as unknown as (
      uri: { fsPath: string },
      bytes: Uint8Array
    ) => Promise<void>;
    workspace.fs.writeFile = (async (
      uri: { fsPath: string },
      bytes: Uint8Array
    ) => {
      written += 1;
      await write(uri, bytes);
    }) as never;

    const outcome = await mergeOne(plan, token);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe("取りやめました");
    // **写し終えた分は消さない**（消すと、途中まで進んだ意味が無くなる）
    expect(has("C:/書庫/いじめられっ子/本文/001.txt")).toBe(true);
    expect(has("C:/書庫/いじめられっ子/本文/003.txt")).toBe(false);
  });

  it("取りやめても、元のフォルダーは丸ごと無事（実機確認リスト A-8 の代わり）", async () => {
    for (const name of ["001.txt", "002.txt", "003.txt"]) {
      put(`C:/小説/いじめられっ子/本文/${name}`, new Uint8Array([1]));
    }
    const token = { isCancellationRequested: true } as never;

    await mergeOne(plan, token);

    for (const name of ["001.txt", "002.txt", "003.txt"]) {
      expect(has(`C:/小説/いじめられっ子/本文/${name}`)).toBe(true);
    }
  });

  it("すでに同じ名前があれば、1バイトも書かない（実機確認リスト A-8 の代わり）", async () => {
    put("C:/小説/いじめられっ子/本文/001.txt", new Uint8Array([1]));
    put("C:/書庫/いじめられっ子/本文/古い.txt", new Uint8Array([9]));

    const outcome = await mergeOne(plan, running);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("上書きしません");
    expect(has("C:/書庫/いじめられっ子/本文/001.txt")).toBe(false);
  });
});

/**
 * 作品一覧（登録簿）の指す先。
 *
 * **新しい先を足してから、古い登録を外す。** 逆にすると、途中で失敗した
 * ときに作品が一覧から消える。
 */
describe("作品一覧の指す先", () => {
  function fakeRegistry(): {
    registry: WorkRegistry;
    calls: string[];
  } {
    const calls: string[] = [];
    const registry = {
      addExisting: async (folderPath: string, title: string) => {
        calls.push(`add:${folderPath}:${title}`);
      },
      remove: async (id: string) => {
        calls.push(`remove:${id}`);
      },
    } as unknown as WorkRegistry;
    return { registry, calls };
  }

  const ok: MergeOutcome = {
    workId: "w1",
    title: "いじめられっ子",
    ok: true,
    destination: "C:/書庫/いじめられっ子",
  };

  it("新しい場所を足してから、元の登録を外す（実機確認リスト A-8 の代わり）", async () => {
    const { registry, calls } = fakeRegistry();

    await reregister(registry, [ok], [plan]);

    expect(calls).toEqual([
      "add:C:/書庫/いじめられっ子:いじめられっ子",
      "remove:w1",
    ]);
  });

  it("写せなかった作品は、元の登録のまま残す（実機確認リスト A-8 の代わり）", async () => {
    // ここで登録を外すと、作者は作品を見失う
    const { registry, calls } = fakeRegistry();
    const failed: MergeOutcome = {
      workId: "w1",
      title: "いじめられっ子",
      ok: false,
      detail: "写せませんでした",
    };

    await reregister(registry, [failed], [plan]);

    expect(calls).toEqual([]);
  });

  it("新しい先を足せなければ、元の登録を外さない（実機確認リスト A-8 の代わり）", async () => {
    const calls: string[] = [];
    const registry = {
      addExisting: async () => {
        throw new Error("登録できません");
      },
      remove: async (id: string) => {
        calls.push(`remove:${id}`);
      },
    } as unknown as WorkRegistry;

    await reregister(registry, [ok], [plan]);

    expect(calls).toEqual([]);
  });
});
