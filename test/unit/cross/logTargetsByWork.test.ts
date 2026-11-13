import * as path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ログの書き先の作品は在るものとして扱う（作り物の道はディスクに無い）。無い作品へ書かない決まりは
// `core/logMissingWork.test.ts` が見る（2026-11-14）
vi.mock("../../../src/core/workFolderPresence", () => ({
  isWorkFolderPresent: async () => true,
  findMissingWorks: async () => [],
}));
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import { PostingStore } from "../../../src/core/postingStore";
import { ChapterStore } from "../../../src/core/chapterStore";
import { ChapterProposalApplier } from "../../../src/features/proposeChapters";
import {
  setFallbackLogRoot,
  settleLogWrites,
  useLogFile,
} from "../../../src/core/logger";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 処理が作品を知っているときは、記録をその作品の操作の記録
 * （`.aiwriter/logs/actions.log`）へ書く（作者の裁定 2026-11-05、書き先の洗い出し）。
 *
 * 共有の書き先は「直前に動いた別の操作」のものになりうる。ここでは共有の書き先を
 * 保管庫（作品の外）に向けたまま呼び、**それでも作品の記録に入る**ことを見る。
 * 直す前は、保管庫の記録へ入って作品の記録には残らなかった。
 */

const work: WorkEntry = {
  id: "work_log",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "logwork"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const workLogPath = Uri.file(
  path.join(work.folderPath, ".aiwriter", "logs", "actions.log")
).fsPath;
const vaultLogPath = Uri.file(
  path.join("C:", "vault", ".aiwriter", "logs", "actions.log")
).fsPath;

const disk = new Map<string, Uint8Array>();

function text(filePath: string): string {
  const bytes = disk.get(filePath);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

beforeEach(() => {
  disk.clear();
  workspace.textDocuments = [];
  workspace.fs = memoryFs(disk);
  setFallbackLogRoot(path.join("C:", "vault"));
  useLogFile(undefined);
});

afterEach(async () => {
  await settleLogWrites();
  useLogFile(undefined);
});

describe("作品を知っている処理は、その作品の記録へ書く", () => {
  test("投稿台帳の読み飛ばしは、その作品の記録に残る", async () => {
    const ledgerPath = Uri.file(
      path.join(work.folderPath, "設定", "投稿状態.json")
    ).fsPath;
    disk.set(
      ledgerPath,
      new TextEncoder().encode(
        JSON.stringify({
          sites: [],
          posts: [],
          completion: { value: "paused-forever", setAt: "2026-11-01T00:00:00.000Z" },
        })
      )
    );

    await new PostingStore(work).load();
    await settleLogWrites();

    expect(text(workLogPath)).toContain("paused-forever");
    expect(text(vaultLogPath)).not.toContain("paused-forever");
  });

  test("章立ての提案の反映の失敗は、その作品の記録に残る", async () => {
    const chaptersPath = Uri.file(
      path.join(work.folderPath, "設定", "章立て.json")
    ).fsPath;
    const store = new ChapterStore(work);
    const applier = new ChapterProposalApplier(
      store,
      await store.load(),
      work.folderPath
    );
    // 読んだあとに外で台帳が変わった（ハッシュ照合で書けない）
    disk.set(
      chaptersPath,
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: "1",
          chapters: [{ name: "外で足した章", startEpisodePath: "本文/009.txt" }],
        })
      )
    );

    const result = await applier.apply({
      name: "出立の章",
      startEpisodePath: "本文/001.txt",
    });
    await settleLogWrites();

    expect(result.ok).toBe(false);
    expect(text(workLogPath)).toContain("章立ての提案の反映");
    expect(text(vaultLogPath)).not.toContain("章立ての提案の反映");
  });
});
