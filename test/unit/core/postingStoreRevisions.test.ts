import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { PostingStore } from "../../../src/core/postingStore";
import { withRevision } from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * 修正版の出し直しの記録が、保存を通って残るか（設計書6.68.7）。
 *
 * `PostingStore.save` は欄を名指しで書く。名指しし忘れると、記録しても保存で消える。
 */

const work: WorkEntry = {
  id: "work_revision_store",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "revision-store"),
  registeredAt: "2026-11-03T00:00:00.000Z",
};

const ledgerPath = Uri.file(path.join(work.folderPath, "設定", "投稿状態.json")).fsPath;

describe("出し直しの記録の保存", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk);
  });

  test("保存して読み直しても、出し直しの記録が残る", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    await store.save(
      withRevision(
        {
          ...ledger,
          sites: [{ site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/1/episodes/new" }],
          posts: [{ episodePath: "本文/001.txt", site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z" }],
        },
        "本文/001.txt",
        "kakuyomu",
        "2026-11-03T00:00:00.000Z"
      )
    );

    const reopened = await new PostingStore(work).load();
    expect(reopened.revisions).toEqual([
      { episodePath: "本文/001.txt", site: "kakuyomu", revisedAt: "2026-11-03T00:00:00.000Z" },
    ]);
    expect(reopened.posts).toHaveLength(1);
  });

  test("出し直しが1件も無ければ、欄ごと書かない（使っていない作品の台帳を膨らませない）", async () => {
    const store = new PostingStore(work);
    await store.save(await store.load());
    const text = new TextDecoder().decode(disk.get(ledgerPath));
    expect(text).not.toContain("revisions");
  });
});
