import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  exportFileBaseName,
  exportFileNameCandidates,
  writeAudienceExport,
} from "../../src/features/exportSettingsForAudience";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

/**
 * 提供先を選んだ設定資料の書き出し（設計書6.75）。
 *
 * **既存ファイルは上書きできない**（`atomicWrite.ts`）。同じ提供先へ
 * 2回書き出すと名前がぶつかるので、`timestampedFileName` の流儀で
 * 別名へ逃げる。ここで確かめるのは「名前の形」と「前のものを潰さない」
 * ことの2つで、どちらも実機まで行かないと気づけない種類の失敗である。
 */

/** 2026-09-05 14:30:05 */
const AT = new Date(2026, 8, 5, 14, 30, 5);

describe("書き出すファイルの名前", () => {
  test("提供先と時点が名前に入る", () => {
    expect(exportFileBaseName("illustration", 12)).toBe(
      "設定資料（イラスト発注用・第12話まで）"
    );
    expect(exportFileBaseName("editorial", null)).toBe(
      "設定資料（編集部用・全話）"
    );
    expect(exportFileBaseName("introduction", 3)).toBe(
      "設定資料（紹介用・第3話まで）"
    );
  });

  test("いちばん先に試すのは、時刻の付かない名前", () => {
    // 何度も書き出すものではないので、ふだんは読みやすい名前で置く
    expect(exportFileNameCandidates("illustration", 12, AT, 3)).toEqual([
      "設定資料（イラスト発注用・第12話まで）.md",
      "設定資料（イラスト発注用・第12話まで） 2026-09-05 1430.md",
      "設定資料（イラスト発注用・第12話まで） 2026-09-05 143005.md",
    ]);
  });
});

describe("書き出し", () => {
  const DIRECTORY = "C:\\works\\灯の塔\\設定";
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();

  const key = (fullPath: string) => Uri.file(fullPath).fsPath;

  function names(): string[] {
    return [...files.keys()]
      .map((full) => full.slice(full.lastIndexOf("\\") + 1))
      .sort();
  }

  beforeEach(() => {
    files.clear();
    directories.clear();
    workspace.fs = {
      createDirectory: vi.fn(async (uri: { fsPath: string }) => {
        directories.add(uri.fsPath);
      }),
      stat: vi.fn(async (uri: { fsPath: string }) => {
        const found = files.get(uri.fsPath);
        if (!found) throw new FileSystemError("missing", "FileNotFound");
        return { type: 1, ctime: 0, mtime: 0, size: found.length };
      }),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(uri.fsPath, bytes);
      }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const found = files.get(uri.fsPath);
        if (!found) throw new FileSystemError("missing", "FileNotFound");
        return found;
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
        files.delete(uri.fsPath);
      }),
    } as never;
  });

  test("置き場を作ってから、提供先の名前で書く", async () => {
    const target = await writeAudienceExport(
      DIRECTORY,
      "illustration",
      12,
      "本文",
      AT
    );

    expect(directories.has(key(DIRECTORY))).toBe(true);
    expect(target.endsWith("設定資料（イラスト発注用・第12話まで）.md")).toBe(
      true
    );
    expect(new TextDecoder().decode(files.get(key(target)))).toBe("本文");
  });

  test("同じ提供先へ2度書いても、前のものを潰さない", async () => {
    await writeAudienceExport(DIRECTORY, "illustration", 12, "1回目", AT);
    await writeAudienceExport(DIRECTORY, "illustration", 12, "2回目", AT);

    expect(names()).toEqual([
      "設定資料（イラスト発注用・第12話まで） 2026-09-05 1430.md",
      "設定資料（イラスト発注用・第12話まで）.md",
    ]);
    // 1回目の中身がそのまま残っている＝上書きされていない
    expect(
      new TextDecoder().decode(
        files.get(key(`${DIRECTORY}\\設定資料（イラスト発注用・第12話まで）.md`))
      )
    ).toBe("1回目");
  });

  test("作者が置いた同名のファイルも潰さない", async () => {
    // 「設定資料（紹介用・全話）.md」を作者が手で作っていることがある
    const byAuthor = `${DIRECTORY}\\設定資料（紹介用・全話）.md`;
    files.set(key(byAuthor), new TextEncoder().encode("作者が書いたもの"));

    const target = await writeAudienceExport(
      DIRECTORY,
      "introduction",
      null,
      "書き出し",
      AT
    );

    expect(target).not.toBe(byAuthor);
    expect(new TextDecoder().decode(files.get(key(byAuthor)))).toBe(
      "作者が書いたもの"
    );
  });
});
