import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { registeredPostingSites } from "../../src/features/postingCopyRegistered";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

/**
 * 「投稿サイト用に変換してコピー」で、登録済みの投稿先を先頭に出すための
 * 手がかり（設計書6.68.2）。
 *
 * **3つの入口（普通のエディタ・作品一覧の右クリック・原稿エディタ）が
 * 同じものを使う。** 入口ごとに台帳を読む処理を写すと、片方だけが直る日が
 * 来る。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("登録してある投稿先を読む", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;
  });

  test("台帳に書いてある順のまま返す", async () => {
    disk.set(
      ledgerPath,
      utf8(
        JSON.stringify({
          sites: [
            { site: "narou", newEpisodeUrl: "https://syosetu.com/" },
            { site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/" },
          ],
          posts: [],
        })
      )
    );

    expect(await registeredPostingSites(work)).toEqual(["narou", "kakuyomu"]);
  });

  test("台帳がまだ無ければ、登録なしとして返す", async () => {
    expect(await registeredPostingSites(work)).toEqual([]);
  });

  test("作品が分からないときも、登録なしとして返す", async () => {
    // 本文がどの作品のものか引けないことはある（作品の外のファイルなど）
    expect(await registeredPostingSites(undefined)).toEqual([]);
  });

  test("台帳が壊れていても、コピー自体は止めない", async () => {
    // ここで要るのは選択肢の並びを決める手がかりだけで、
    // 無くてもコピーはできる。台帳が壊れているときに
    // 「投稿サイト用にコピー」まで使えなくなるほうが困る
    disk.set(ledgerPath, utf8("{ sites: 壊れている"));

    await expect(registeredPostingSites(work)).resolves.toEqual([]);
  });
});
