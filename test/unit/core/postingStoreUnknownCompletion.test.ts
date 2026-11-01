import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PostingStore,
  onPostingUnknownValues,
} from "../../../src/core/postingStore";
import { withSiteFacts, withWorkCompletion } from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * 知らない連載の状態を読んだときの台帳の持ち回り（作者の判断 2026-11-01）。
 *
 * - **台帳ごと止めない**（投稿の記録は読める）
 * - **保存で消さない**——読まなかった値は、新しい版の機械が書いた値かもしれない
 *   （読者の反応の読み飛ばした行と同じ扱い。実装ルール2）
 * - 作者が新しく選んだ・新しい封筒が知っている値を入れたときは、そちらが勝つ
 * - 読み飛ばしたことは、知らせの口（`onPostingUnknownValues`）へ渡す
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const ledgerPath = Uri.file(path.join(work.folderPath, "設定", "投稿状態.json")).fsPath;

const unknownWork = { value: "paused-forever", setAt: "2026-11-01T00:00:00.000Z" };
const unknownSite = {
  site: "kakuyomu",
  tags: ["幽霊"],
  tagsAt: "2026-11-01T00:00:00.000Z",
  completion: "paused-forever",
  completionAt: "2026-11-01T00:00:00.000Z",
};

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("知らない連載の状態の持ち回り", () => {
  const disk = new Map<string, Uint8Array>();
  const heard: Array<{ filePath: string; notes: readonly string[] }> = [];
  let stop: { dispose(): void } | undefined;

  beforeEach(() => {
    disk.clear();
    heard.length = 0;
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk);
    disk.set(
      ledgerPath,
      utf8(
        JSON.stringify({
          sites: [],
          posts: [{ episodePath: "本文/001.txt", site: "narou", postedAt: "2026-09-04T10:00:00.000Z" }],
          siteFacts: [unknownSite],
          completion: unknownWork,
        })
      )
    );
    stop = onPostingUnknownValues((info) => heard.push(info));
  });

  afterEach(() => stop?.dispose());

  function written(): Record<string, unknown> {
    return JSON.parse(new TextDecoder().decode(disk.get(ledgerPath)!)) as Record<string, unknown>;
  }

  test("読める。投稿の記録は残り、知らない欄だけが無い", async () => {
    const ledger = await new PostingStore(work).load();
    expect(ledger.posts).toHaveLength(1);
    expect(ledger.completion).toBeUndefined();
    expect(ledger.siteFacts?.[0]?.completion).toBeUndefined();
    expect(ledger.siteFacts?.[0]?.tags).toEqual(["幽霊"]);
  });

  test("知らせの口へ、どの台帳で何を読まなかったかを渡す", async () => {
    await new PostingStore(work).load();
    expect(heard).toHaveLength(1);
    // ドライブ名の大小は道具で揺れるので見ない
    expect(heard[0].filePath.toLowerCase()).toBe(ledgerPath.toLowerCase());
    expect(heard[0].notes.join("\n")).toContain("paused-forever");
  });

  test("ほかの欄を書き換えて保存しても、知らない値は元の形のまま残る", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    await store.save({
      ...ledger,
      posts: [
        ...ledger.posts,
        { episodePath: "本文/002.txt", site: "narou", postedAt: "2026-09-05T10:00:00.000Z" },
      ],
    });
    const after = written();
    expect(after.completion).toEqual(unknownWork);
    expect(after.siteFacts).toEqual([unknownSite]);
  });

  test("作者が選び直したら、作者の値が勝つ", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    await store.save(withWorkCompletion(ledger, "hiatus", "2026-11-02T00:00:00.000Z"));
    expect(written().completion).toEqual({ value: "hiatus", setAt: "2026-11-02T00:00:00.000Z" });
  });

  test("新しい封筒が知っている値を入れたら、そちらが勝つ", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    const next = withSiteFacts(ledger, {
      site: "kakuyomu",
      readAt: "2026-11-02T00:00:00.000Z",
      completion: "ongoing",
    }).ledger;
    await store.save(next);
    const facts = written().siteFacts as Array<Record<string, unknown>>;
    expect(facts[0].completion).toBe("ongoing");
    expect(facts[0].completionAt).toBe("2026-11-02T00:00:00.000Z");
    expect(facts[0].tags).toEqual(["幽霊"]);
  });

  test("壊れたJSONは今までどおり止める（知らせの口へは渡さない）", async () => {
    disk.set(ledgerPath, utf8(JSON.stringify({ sites: [], posts: [], completion: { value: 1 } })));
    await expect(new PostingStore(work).load()).rejects.toThrow();
    expect(heard).toHaveLength(0);
  });
});
