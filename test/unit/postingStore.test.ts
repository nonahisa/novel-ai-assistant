import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { PostingStore, PostingStoreError } from "../../src/core/postingStore";
import { emptyPostingLedger } from "../../src/models/posting";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

/**
 * 投稿状態の台帳の読み書き（設計書6.68.2）。
 *
 * `設定/投稿状態.json` はGitで同期する。**PCで書いてスマホから投稿する**
 * 使い方をするので、開いたまま別の端末で書かれることが現実に起きる。
 * 章立て・本の設計図と同じく、**外で変わっていたら上書きせずに止める**。
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

const kakuyomuUrl = "https://kakuyomu.jp/my/works/1177354054892/episodes/new";

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("投稿状態の台帳の読み書き", () => {
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
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;
  });

  test("まだ無ければ、記録が1つも無い台帳として読める", async () => {
    expect(await new PostingStore(work).load()).toEqual(emptyPostingLedger());
  });

  test("保存したものは、そのまま読み直せる", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    await store.save({
      ...ledger,
      sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
      posts: [
        {
          episodePath: "本文/001.txt",
          site: "kakuyomu",
          postedAt: "2026-09-04T10:00:00.000Z",
        },
      ],
    });

    const reopened = await new PostingStore(work).load();
    expect(reopened.sites).toEqual([
      { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl },
    ]);
    expect(reopened.posts).toHaveLength(1);
  });

  test("自分で保存したものは、続けて保存できる（1サイトごとに書くため）", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    await store.save({
      ...ledger,
      posts: [
        { episodePath: "本文/001.txt", site: "narou", postedAt: "2026-09-04T10:00:00.000Z" },
      ],
    });
    await store.save({
      ...ledger,
      posts: [
        { episodePath: "本文/001.txt", site: "narou", postedAt: "2026-09-04T10:00:00.000Z" },
        { episodePath: "本文/001.txt", site: "note", postedAt: "2026-09-04T10:05:00.000Z" },
      ],
    });

    expect((await new PostingStore(work).load()).posts).toHaveLength(2);
  });

  test("読み込んだあとに外で変わっていたら、上書きせずに止める", async () => {
    const outsideFirst = utf8(
      JSON.stringify({
        posts: [
          { episodePath: "本文/001.txt", site: "note", postedAt: "2026-09-01T00:00:00.000Z" },
        ],
      })
    );
    disk.set(ledgerPath, outsideFirst);
    const store = new PostingStore(work);
    const ledger = await store.load();

    // スマホ側で先に投稿して、同期で降ってきた
    const outside = utf8(
      JSON.stringify({
        posts: [
          { episodePath: "本文/002.txt", site: "note", postedAt: "2026-09-04T00:00:00.000Z" },
        ],
      })
    );
    disk.set(ledgerPath, outside);

    await expect(store.save({ ...ledger, posts: [] })).rejects.toMatchObject({
      kind: "modified_externally",
    });
    expect(disk.get(ledgerPath)).toEqual(outside);
  });

  test("読み込みのときに無かったファイルが、外で作られていたら止める", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    const outside = utf8(JSON.stringify({ posts: [] }));
    disk.set(ledgerPath, outside);

    await expect(store.save(ledger)).rejects.toMatchObject({
      kind: "modified_externally",
    });
    expect(disk.get(ledgerPath)).toEqual(outside);
  });

  test("壊れたJSONは修復しない（読めないと言って止まる）", async () => {
    disk.set(ledgerPath, utf8("{ posts: 壊れている"));
    const store = new PostingStore(work);

    await expect(store.load()).rejects.toMatchObject({ kind: "invalid_json" });
    // 読めていないので、保存もさせない
    await expect(store.save(emptyPostingLedger())).rejects.toBeInstanceOf(
      PostingStoreError
    );
    expect(new TextDecoder().decode(disk.get(ledgerPath))).toBe(
      "{ posts: 壊れている"
    );
  });

  /**
   * 導入時にまとめて入れた記録（基準線）の印は、保存で落とさない。
   * 落とすと、あとから台帳を読んだときに実投稿と見分けられなくなる。
   */
  test("基準線の印は、保存して読み直しても残る", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    await store.save({
      ...ledger,
      posts: [
        {
          episodePath: "本文/001.txt",
          site: "narou",
          postedAt: "2026-09-04T00:00:00.000Z",
          importedBaseline: true,
        },
        {
          episodePath: "本文/002.txt",
          site: "narou",
          postedAt: "2026-09-04T00:10:00.000Z",
        },
      ],
    });

    const reopened = await new PostingStore(work).load();
    expect(reopened.posts[0].importedBaseline).toBe(true);
    // 実際に投稿したほうには印を付けない（`undefined` のまま）
    expect(reopened.posts[1].importedBaseline).toBeUndefined();
  });

  /**
   * サイトごとの作品情報とランキング（設計書6.68.5）。
   *
   * **保存で落とさない。** 書き戻すときに項目ごと消えると、作者が
   * 手で入れた作品IDやジャンルが投稿1回ぶんの記録と引き換えに消える。
   */
  test("作品情報とランキングは、保存して読み直しても残る", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    await store.save({
      ...ledger,
      sites: [
        {
          site: "kakuyomu",
          newEpisodeUrl: kakuyomuUrl,
          profile: {
            workId: "1177354054892",
            workUrl: "https://kakuyomu.jp/works/1177354054892",
            genre: "異世界ファンタジー",
          },
        },
      ],
      rankings: [
        {
          site: "kakuyomu",
          recordedAt: "2026-09-04T00:00:00.000Z",
          board: "週間",
          rank: 12,
          note: "更新直後",
        },
      ],
    });

    const reopened = await new PostingStore(work).load();
    expect(reopened.sites[0].profile?.genre).toBe("異世界ファンタジー");
    expect(reopened.rankings).toEqual([
      {
        site: "kakuyomu",
        recordedAt: "2026-09-04T00:00:00.000Z",
        board: "週間",
        rank: 12,
        note: "更新直後",
      },
    ]);
  });

  /** この機能より前に作られた台帳（`rankings` も `profile` も無い）を読む */
  test("欄の無い古い台帳を読んでも、投稿の記録は変わらない", async () => {
    disk.set(
      ledgerPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
          posts: [
            {
              episodePath: "本文/001.txt",
              site: "kakuyomu",
              postedAt: "2026-09-01T00:00:00.000Z",
            },
          ],
        })
      )
    );

    const store = new PostingStore(work);
    const ledger = await store.load();
    expect(ledger.rankings).toEqual([]);
    expect(ledger.sites[0].profile).toBeUndefined();

    // 読んだものをそのまま書き戻せる（外部変更の照合にも引っかからない）
    await store.save(ledger);
    const reopened = await new PostingStore(work).load();
    expect(reopened.posts[0].postedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("知らないサイトが書いてあれば、読めないと言って止める", async () => {
    disk.set(
      ledgerPath,
      utf8(JSON.stringify({ sites: [{ site: "pixiv", newEpisodeUrl: "https://www.pixiv.net/" }] }))
    );

    await expect(new PostingStore(work).load()).rejects.toMatchObject({
      kind: "invalid_json",
    });
  });

  test("エディタに未保存の変更があれば書き込まない", async () => {
    const store = new PostingStore(work);
    const ledger = await store.load();
    workspace.textDocuments = [
      { uri: { fsPath: ledgerPath }, isDirty: true, getText: () => "" },
    ];

    await expect(
      store.save({
        ...ledger,
        posts: [
          { episodePath: "本文/001.txt", site: "note", postedAt: "2026-09-04T00:00:00.000Z" },
        ],
      })
    ).rejects.toMatchObject({ kind: "unsaved_changes" });
    expect(disk.has(ledgerPath)).toBe(false);
  });

  test("読み込む前には保存しない", async () => {
    await expect(
      new PostingStore(work).save(emptyPostingLedger())
    ).rejects.toBeInstanceOf(PostingStoreError);
    expect(disk.has(ledgerPath)).toBe(false);
  });
});
