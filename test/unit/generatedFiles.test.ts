import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  generatedFileName,
  generatedFileNameCandidates,
  generatedNamePrefix,
  pruneGeneratedFiles,
  selectFilesToPrune,
  writeGeneratedFile,
  type GeneratedFileEntry,
} from "../../src/core/generatedFiles";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

/**
 * その場で組み立てる読み物を、実ファイルとして置く（設計書6.17.7）。
 *
 * 無題文書をやめた代わりに、置きっぱなしのファイルが溜まる。
 * **消す処理は、間違えたときに取り返しがつかない**ので、
 * 「何を消すか」の判断を重点的に確かめる。
 */

/** 2026-08-29 14:30:05 */
const AT = new Date(2026, 7, 29, 14, 30, 5);

describe("生成文書のファイル名", () => {
  test("種類・日付・時刻を `_` でつないだ名前になる", () => {
    expect(generatedFileName("執筆再開", AT)).toBe("執筆再開_2026-08-29_1430.md");
  });

  test("同じ分・同じ秒にぶつかったら、秒 → 連番の順で避ける", () => {
    // 避け方は `timestampedFileName.ts` が持っている規則そのもの。
    // ここでは「生成文書もその規則に乗っている」ことだけを見る
    expect(generatedFileNameCandidates("執筆再開", AT, 3)).toEqual([
      "執筆再開_2026-08-29_1430.md",
      "執筆再開_2026-08-29_143005.md",
      "執筆再開_2026-08-29_143005-2.md",
    ]);
  });

  test("ファイル名に使えない文字を落とす", () => {
    // 無題文書の名前（`untitledMarkdownUri`）と同じ規則を共用している
    expect(generatedFileName("冒頭診断：A/B?C#D", AT)).toBe(
      "冒頭診断：ABCD_2026-08-29_1430.md"
    );
  });

  test("名前が空になっても、種類の場所は空にならない", () => {
    expect(generatedFileName("///", AT)).toBe("無題_2026-08-29_1430.md");
  });

  test("種類の前置きは、名前の頭とそのまま一致する", () => {
    // 掃除はこの前置きで「自分の種類」を見分ける。
    // ずれると、消してよいものを見つけられない（あるいは他人を消す）
    const prefix = generatedNamePrefix("執筆再開");
    expect(generatedFileName("執筆再開", AT).startsWith(prefix)).toBe(true);
  });
});

describe("消してよいものを選ぶ", () => {
  const NOW = new Date(2026, 7, 29, 12, 0, 0);
  const DAY = 24 * 60 * 60 * 1000;
  const POLICY = { keep: 20, maxAgeDays: 30 };

  /** `daysAgo` 日前に書かれた生成文書 */
  function aged(name: string, daysAgo: number): GeneratedFileEntry {
    return { name, mtime: NOW.getTime() - daysAgo * DAY };
  }

  test("新しい順に keep 件を残し、あふれた分だけを消す", () => {
    const entries = [
      aged("執筆再開_2026-08-29_1200.md", 0),
      aged("執筆再開_2026-08-28_1200.md", 1),
      aged("執筆再開_2026-08-27_1200.md", 2),
      aged("執筆再開_2026-08-26_1200.md", 3),
    ];

    expect(selectFilesToPrune(entries, "執筆再開", { keep: 2, maxAgeDays: 30 }, NOW))
      .toEqual([
        "執筆再開_2026-08-27_1200.md",
        "執筆再開_2026-08-26_1200.md",
      ]);
  });

  test("並びが入れ替わっていても、古いほうから消す", () => {
    // 置き場から読んだ順は保証されない。**順序が定まらないと、
    // 残る20件が実行のたびに入れ替わる**
    const entries = [
      aged("執筆再開_2026-08-26_1200.md", 3),
      aged("執筆再開_2026-08-29_1200.md", 0),
      aged("執筆再開_2026-08-27_1200.md", 2),
    ];

    expect(
      selectFilesToPrune(entries, "執筆再開", { keep: 1, maxAgeDays: 30 }, NOW)
    ).toEqual([
      "執筆再開_2026-08-27_1200.md",
      "執筆再開_2026-08-26_1200.md",
    ]);
  });

  test("件数に余裕があっても、maxAgeDays より古いものは消す", () => {
    const entries = [
      aged("執筆再開_2026-08-29_1200.md", 0),
      aged("執筆再開_2026-06-20_1200.md", 40),
    ];

    expect(selectFilesToPrune(entries, "執筆再開", POLICY, NOW)).toEqual([
      "執筆再開_2026-06-20_1200.md",
    ]);
  });

  test("境目のちょうど30日は、まだ消さない", () => {
    const entries = [aged("執筆再開_2026-07-30_1200.md", 30)];
    expect(selectFilesToPrune(entries, "執筆再開", POLICY, NOW)).toEqual([]);
  });

  test("別の種類には触らない", () => {
    const entries = [
      aged("執筆再開_2026-06-20_1200.md", 40),
      aged("使い方_2026-06-20_1200.md", 40),
      aged("冒頭診断_2026-06-20_1200.md", 40),
    ];

    expect(selectFilesToPrune(entries, "執筆再開", POLICY, NOW)).toEqual([
      "執筆再開_2026-06-20_1200.md",
    ]);
  });

  test("作者が手で置いたファイルには触らない", () => {
    // **ここが緩むと、作者の書きかけが消える。**
    // 種類の名前で始まっていても、`_` の区切りが無ければ別物として扱う
    const entries = [
      aged("メモ.md", 40),
      aged("執筆再開のメモ.md", 40),
      aged("執筆再開_2026-06-20_1200.txt", 40),
      aged("執筆再開_2026-06-20_1200.md", 40),
    ];

    expect(
      selectFilesToPrune(entries, "執筆再開", { keep: 0, maxAgeDays: 30 }, NOW)
    ).toEqual(["執筆再開_2026-06-20_1200.md"]);
  });

  test("`_` で区切ってあっても、時刻の形をしていなければ触らない", () => {
    // **前置きと `.md` だけを見ていると、作者が置いた `冒頭診断_メモ.md` が
    // 消える。** この仕組みが作る名前は必ず日付と時刻を持つ
    const entries = [
      aged("冒頭診断_メモ.md", 40),
      aged("冒頭診断_2026-06-20.md", 40),
      aged("冒頭診断_2026-06-20_12.md", 40),
      aged("冒頭診断_下書き_2026-06-20_1200.md", 40),
      aged("冒頭診断_2026-06-20_1200.md", 40),
    ];

    expect(
      selectFilesToPrune(entries, "冒頭診断", { keep: 0, maxAgeDays: 30 }, NOW)
    ).toEqual(["冒頭診断_2026-06-20_1200.md"]);
  });

  test("この仕組みが作る名前は、どれも掃除の対象になる", () => {
    // 名前の作り方（`timestampedFileName.ts`）を変えたときに掃除だけが
    // 取り残されると、消えない読み物が静かに溜まり続ける
    const names = generatedFileNameCandidates("冒頭診断", AT);
    const entries = names.map((name) => aged(name, 40));

    expect(
      selectFilesToPrune(entries, "冒頭診断", { keep: 0, maxAgeDays: 30 }, NOW)
    ).toHaveLength(names.length);
  });

  test("消すものが無ければ、空のまま返す", () => {
    expect(selectFilesToPrune([], "執筆再開", POLICY, NOW)).toEqual([]);
  });
});

/**
 * 置き場に対して実際に書く・消す部分。
 *
 * ファイルの仕組みは作り物に差し替える（`atomicWrite.test.ts` と同じ手）。
 */
describe("置き場への書き出しと片付け", () => {
  const DIRECTORY = "C:\\works\\ある作品\\.aiwriter\\generated";
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  const directories = new Set<string>();
  const deleted: string[] = [];

  function key(location: string): string {
    return Uri.file(location).fsPath;
  }

  function place(name: string, mtime: number): void {
    files.set(key(`${DIRECTORY}\\${name}`), {
      bytes: new TextEncoder().encode("既にあるもの"),
      mtime,
    });
  }

  function names(): string[] {
    return [...files.keys()]
      .map((full) => full.slice(full.lastIndexOf("\\") + 1))
      .sort();
  }

  beforeEach(() => {
    files.clear();
    directories.clear();
    deleted.length = 0;
    workspace.fs = {
      createDirectory: vi.fn(async (uri: { fsPath: string }) => {
        directories.add(uri.fsPath);
      }),
      stat: vi.fn(async (uri: { fsPath: string }) => {
        const found = files.get(uri.fsPath);
        if (!found) throw new FileSystemError("missing", "FileNotFound");
        return {
          type: 1,
          ctime: found.mtime,
          mtime: found.mtime,
          size: found.bytes.length,
        };
      }),
      readDirectory: vi.fn(async (uri: { fsPath: string }) => {
        if (uri.fsPath !== key(DIRECTORY)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return [...files.keys()].map((full) => [
          full.slice(full.lastIndexOf("\\") + 1),
          1,
        ]);
      }),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(uri.fsPath, { bytes, mtime: Date.now() });
      }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const found = files.get(uri.fsPath);
        if (!found) throw new FileSystemError("missing", "FileNotFound");
        return found.bytes;
      }),
      rename: vi.fn(
        async (
          from: { fsPath: string },
          to: { fsPath: string },
          options?: { overwrite?: boolean }
        ) => {
          const found = files.get(from.fsPath);
          if (!found) throw new Error("一時ファイルがありません");
          if (!options?.overwrite && files.has(to.fsPath)) {
            throw new FileSystemError("exists", "FileExists");
          }
          files.set(to.fsPath, found);
          files.delete(from.fsPath);
        }
      ),
      delete: vi.fn(async (uri: { fsPath: string }) => {
        if (!files.delete(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        deleted.push(uri.fsPath.slice(uri.fsPath.lastIndexOf("\\") + 1));
      }),
    } as never;
  });

  test("置き場を作ってから、種類と時刻の名前で書く", async () => {
    const target = await writeGeneratedFile(DIRECTORY, "執筆再開", "本文", AT);

    expect(directories.has(key(DIRECTORY))).toBe(true);
    expect(target.endsWith("執筆再開_2026-08-29_1430.md")).toBe(true);
    expect(
      new TextDecoder().decode(files.get(key(target))?.bytes)
    ).toBe("本文");
  });

  test("同じ時刻に2度書いても、前のものを潰さない", async () => {
    // **既存ファイルの上書きは禁じられている**（`atomicWrite.ts`）。
    // 名前をずらして逃げるところまでが1組
    await writeGeneratedFile(DIRECTORY, "執筆再開", "1回目", AT);
    await writeGeneratedFile(DIRECTORY, "執筆再開", "2回目", AT);

    expect(names()).toEqual([
      "執筆再開_2026-08-29_1430.md",
      "執筆再開_2026-08-29_143005.md",
    ]);
  });

  test("同じ種類の古いものだけを消し、件数を返す", async () => {
    const now = new Date(2026, 7, 29, 12, 0, 0);
    const day = 24 * 60 * 60 * 1000;
    place("執筆再開_2026-08-29_1200.md", now.getTime());
    place("執筆再開_2026-06-20_1200.md", now.getTime() - 40 * day);
    place("使い方_2026-06-20_1200.md", now.getTime() - 40 * day);
    place("作者のメモ.md", now.getTime() - 40 * day);

    const removed = await pruneGeneratedFiles(
      DIRECTORY,
      "執筆再開",
      { keep: 20, maxAgeDays: 30 },
      now
    );

    expect(removed).toBe(1);
    expect(deleted).toEqual(["執筆再開_2026-06-20_1200.md"]);
    expect(names()).toEqual([
      "作者のメモ.md",
      "使い方_2026-06-20_1200.md",
      "執筆再開_2026-08-29_1200.md",
    ]);
  });

  test("置き場がまだ無くても、失敗にしない", async () => {
    // 初回は掃除するものが無い。ここで投げると、読み物が開けなくなる
    await expect(
      pruneGeneratedFiles("C:\\works\\無い作品\\.aiwriter\\generated", "使い方")
    ).resolves.toBe(0);
  });
});
