import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { readSiteRecords } from "../../../src/features/writingStatsPanel";
import type { WorkEntry } from "../../../src/models/types";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";

/**
 * 執筆量パネルの「サイトの記録」を読むところ（0.33.9のレビュー、中1）。
 *
 * **台帳が読めなくても執筆量パネルは開く**——ここは添え物なので、投稿状態の
 * 台帳が壊れているからといって文字数のグラフまで見られなくなるのは筋が悪い。
 * ただし**黙って消さない。** 以前はログへ残すだけだったので、作者からは
 * 「サイトの記録」が理由も分からず消えたようにしか見えなかった。
 */

const work: WorkEntry = {
  id: "work_stats",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "stats"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const narouUrl =
  "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/";

const disk = new Map<string, Uint8Array>();

function writeLedger(ledger: unknown): void {
  disk.set(
    ledgerPath,
    new TextEncoder().encode(JSON.stringify(ledger, null, 2))
  );
}

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
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;
});

describe("サイトの記録の読み込み", () => {
  test("読めれば、記録を返して理由は付けない", async () => {
    writeLedger({
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: narouUrl }],
      siteProfiles: [{ site: "narou", workId: "n1234ab" }],
      posts: [],
    });

    const result = await readSiteRecords(work);

    expect(result.error).toBeNull();
    expect(result.records.map((record) => record.site)).toEqual(["narou"]);
  });

  test("読めなければ、理由を返す（グラフは従来どおり出す）", async () => {
    /*
      投稿先のURLが別のサイトを指している台帳。直さずに止めるのが台帳の
      約束である（正しいURLはこちらには分からない）。

      **読者の反応の行では測れなくなった**（0.69.9）。あちらは行ごとに
      飛ばして読むようになったので、1行壊しても台帳は読めてしまう
      ——ここで見たいのは「読めなかった理由が画面へ届くか」である。
    */
    writeLedger({
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: "https://kakuyomu.jp/my/works/1" }],
    });

    const result = await readSiteRecords(work);

    expect(result.records).toEqual([]);
    expect(result.error, "読めなかった理由が画面へ渡らない").toBeTruthy();
    expect(result.error).toContain("投稿状態.json");
  });

  test("台帳が無い作品では、理由も記録も出さない", async () => {
    const result = await readSiteRecords(work);

    expect(result.error).toBeNull();
    expect(result.records).toEqual([]);
  });
});
