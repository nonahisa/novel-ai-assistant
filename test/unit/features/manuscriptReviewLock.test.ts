import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileType, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 原稿エディターへ「校閲中」を知らせる（作者の裁定 2026-11-07。設計書6.25.12）。
 *
 * - 鍵がある話を開いたとき、または鍵が届いたときに、帯の文（編集者の GitHub 名と時刻）を送る
 * - 鍵が外れたら「校閲中でない」を送る
 * - 編集者の名前は `.aiwriter/editing.json` の `editorLogin`（無ければ `formerEditorLogin`）。
 *   **鍵の holder（git の名前）は出さない**
 *
 * 本物のファイルシステムで走らせる。
 */

const { watchReviewLock } = await import("../../../src/features/manuscriptReviewLock");
const { FileLockStore } = await import("../../../src/core/fileLockStore");
const { formatLockSince } = await import("../../../src/core/reviewLockMessages");

const SITE = nodePath.join(".aiwriter", "editing.json");
const SINCE = "2026-11-07T09:30:00.000Z";

function lockLine(kind: "acquire" | "release", file: string, time: string): string {
  return JSON.stringify({ kind, file, holder: "Kei Mizushima", holderKind: "editor", time, note: "" });
}

describe("原稿エディターへ校閲中を知らせる", () => {
  let base = "";
  let root = "";
  const work = (): WorkEntry => ({
    id: "work_banner",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-11-07T00:00:00.000Z",
  });
  const put = async (relative: string, text: string) => {
    const target = nodePath.join(root, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };
  const episode = () => nodePath.join(root, "本文", "002.txt");

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-banner-"));
    root = nodePath.join(base, "氷の街");
    await fsp.mkdir(root, { recursive: true });
    await put(nodePath.join("本文", "002.txt"), "本文");
    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return { type: stat.isDirectory() ? FileType.Directory : FileType.File, size: stat.size };
      },
      readFile: async (uri: { fsPath: string }) => new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, bytes);
      },
    } as unknown as typeof workspace.fs;
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  /**
   * 知らせが落ち着くまで待つ（台帳を読む・書くのは非同期）。
   *
   * **決まった時間では待たない。** 全件を並べて流すと、台帳の読み書きが 30ms では終わらず
   * 揺れた（2026-11-07、npm run check で2件）。待ち始めてから送られたら、そのあと100ms
   * 何も来なくなるまで待つ。何も来なければ2秒で戻る（「送り直さない」を見る件のため）
   */
  let lastPostAt = 0;
  const settle = async (): Promise<void> => {
    const startedAt = Date.now();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const now = Date.now();
      if (lastPostAt >= startedAt && now - lastPostAt >= 100) return;
      if (lastPostAt < startedAt && now - startedAt >= 2000) return;
    }
  };

  function watch(posted: unknown[], editorMode = false) {
    return watchReviewLock({
      work: work,
      filePath: episode(),
      post: (message) => {
        posted.push(message);
        lastPostAt = Date.now();
      },
      editorMode: () => editorMode,
    });
  }

  test("鍵が無い話を開いたら「校閲中でない」", async () => {
    const posted: unknown[] = [];
    const watching = watch(posted);
    await settle();
    watching.dispose();
    expect(posted).toEqual([{ type: "reviewLock", locked: false }]);
  });

  test("鍵がある話を開いたら、帯の文（GitHub 名・時刻）を送る。git の名前は出さない", async () => {
    await put(SITE, JSON.stringify({ editorLogin: "kmizu" }));
    await new FileLockStore(work()).mergeIncoming(`${lockLine("acquire", "本文/002.txt", SINCE)}\n`);
    const posted: Array<{ type: string; locked: boolean; text?: string }> = [];
    const watching = watch(posted);
    await settle();
    watching.dispose();
    expect(posted).toEqual([
      {
        type: "reviewLock",
        locked: true,
        text: `この話は校閲中です（編集者 kmizu・${formatLockSince(SINCE)} から）。編集者が返すと書けます。`,
      },
    ]);
    expect(posted[0]?.text).not.toContain("Kei Mizushima");
  });

  test("鍵が届いたら校閲中を送り、外れたら校閲中でないを送る", async () => {
    await put(SITE, JSON.stringify({ editorLogin: "kmizu" }));
    const posted: Array<{ locked: boolean }> = [];
    const watching = watch(posted);
    await settle();
    expect(posted.map((m) => m.locked)).toEqual([false]);

    const store = new FileLockStore(work());
    await store.mergeIncoming(`${lockLine("acquire", "本文/002.txt", SINCE)}\n`);
    await settle();
    expect(posted.map((m) => m.locked)).toEqual([false, true]);

    await store.mergeIncoming(`${lockLine("release", "本文/002.txt", "2026-11-07T12:00:00.000Z")}\n`);
    await settle();
    watching.dispose();
    expect(posted.map((m) => m.locked)).toEqual([false, true, false]);
  });

  test("ほかの話の鍵が動いても、送り直さない", async () => {
    const posted: unknown[] = [];
    const watching = watch(posted);
    await settle();
    await new FileLockStore(work()).mergeIncoming(`${lockLine("acquire", "本文/003.txt", SINCE)}\n`);
    await settle();
    watching.dispose();
    expect(posted).toHaveLength(1);
  });

  test("名前が分からなければ「編集者」とだけ。解除のあとは前の編集者の名前を使う", async () => {
    await new FileLockStore(work()).mergeIncoming(`${lockLine("acquire", "本文/002.txt", SINCE)}\n`);
    const unnamed: Array<{ text?: string }> = [];
    const first = watch(unnamed);
    await settle();
    first.dispose();
    expect(unnamed[0]?.text).toBe(
      `この話は校閲中です（編集者・${formatLockSince(SINCE)} から）。編集者が返すと書けます。`
    );

    await put(SITE, JSON.stringify({ formerEditorLogin: "kmizu" }));
    const former: Array<{ text?: string }> = [];
    const second = watch(former);
    await settle();
    second.dispose();
    expect(former[0]?.text).toContain("編集者 kmizu・");
  });

  test("編集者モードでは、鍵があっても校閲中を出さない（鍵を掛けた側）", async () => {
    await new FileLockStore(work()).mergeIncoming(`${lockLine("acquire", "本文/002.txt", SINCE)}\n`);
    const posted: unknown[] = [];
    const watching = watch(posted, true);
    await settle();
    watching.dispose();
    expect(posted).toEqual([{ type: "reviewLock", locked: false }]);
  });
});
