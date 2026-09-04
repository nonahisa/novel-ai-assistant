import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { recordRanking } from "../../src/features/postingKit";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, Uri, window, workspace } from "./support/vscodeStub";

/**
 * 「ランキングを記録する」（設計書6.68.5）。
 *
 * **サイトへは取りにいかない。** 作者が画面で見た順位を、そのまま台帳へ
 * 書き足すだけの操作である。ここで確かめるのは3つ。
 *
 *   1. 登録サイトが無い作品では、設定へ誘導して勝手に始めない
 *   2. 種別の候補は、**作者が過去に使った言葉**から作る（決め打ちしない）
 *   3. 追記で、既にある記録（投稿・過去の順位）が1つも変わらない
 */

const work: WorkEntry = {
  id: "work_rank",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "rank"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const narouUrl =
  "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/";
const kakuyomuUrl = "https://kakuyomu.jp/my/works/1177354054892/episodes/new";

interface PickItem {
  label: string;
  [key: string]: unknown;
}

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeLedger(ledger: unknown): void {
  disk.set(ledgerPath, utf8(JSON.stringify(ledger, null, 2)));
}

function readLedger(): {
  posts: Array<Record<string, unknown>>;
  rankings: Array<Record<string, unknown>>;
} {
  const bytes = disk.get(ledgerPath);
  if (!bytes) throw new Error("台帳が書かれていません");
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** 選択画面の答え方。渡された項目を見て1つ返す（`undefined` は取りやめ） */
function stubQuickPick(
  answers: Array<(items: PickItem[]) => unknown>
): PickItem[][] {
  const captured: PickItem[][] = [];
  let index = 0;
  Object.assign(window, {
    showQuickPick: async (items: PickItem[]) => {
      captured.push(items);
      const answer = answers[index++];
      return answer ? answer(items) : undefined;
    },
  });
  return captured;
}

/** 入力欄の答え方。**検証も本物と同じように通す**（迂回すると意味が無い） */
function stubInputs(values: Array<string | undefined>): Array<{
  title?: string;
  rejected?: string;
}> {
  const asked: Array<{ title?: string; rejected?: string }> = [];
  let index = 0;
  Object.assign(window, {
    showInputBox: async (options?: {
      title?: string;
      validateInput?: (value: string) => string | undefined;
    }) => {
      const value = values[index++];
      const rejected =
        value !== undefined && options?.validateInput
          ? options.validateInput(value)
          : undefined;
      asked.push({ title: options?.title, rejected: rejected ?? undefined });
      return value;
    },
  });
  return asked;
}

describe("ランキングを記録する", () => {
  beforeEach(() => {
    disk.clear();
    informed.length = 0;
    warned.length = 0;
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

    Object.assign(window, {
      showInformationMessage: async (message: string) => {
        informed.push(message);
        return undefined;
      },
      showWarningMessage: async (message: string) => {
        warned.push(message);
        return undefined;
      },
      showErrorMessage: async (message: string) => {
        warned.push(message);
        return undefined;
      },
    });
  });

  test("投稿サイトを登録していなければ、設定へ誘導して何も書かない", async () => {
    const picks = stubQuickPick([]);
    stubInputs([]);

    const result = await recordRanking(work);

    expect(result.changed).toBe(false);
    expect(warned.join("")).toContain("投稿サイトの設定");
    // サイトを訊く画面すら出さない（答えようのない質問をしない）
    expect(picks).toHaveLength(0);
    expect(disk.has(ledgerPath)).toBe(false);
  });

  test("過去に使った種別が候補に出て、選んだ順位が追記される", async () => {
    writeLedger({
      schemaVersion: "1",
      sites: [
        { site: "narou", newEpisodeUrl: narouUrl },
        { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl },
      ],
      posts: [
        {
          episodePath: "本文/001.txt",
          site: "narou",
          postedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      rankings: [
        {
          site: "narou",
          recordedAt: "2026-09-01T00:00:00.000Z",
          board: "日間",
          rank: 30,
        },
        {
          site: "narou",
          recordedAt: "2026-09-03T00:00:00.000Z",
          board: "週間",
          rank: 18,
        },
      ],
    });

    const picks = stubQuickPick([
      (items) => items.find((item) => item.site === "narou"),
      (items) => items.find((item) => item.board === "日間"),
    ]);
    const asked = stubInputs(["12", ""]);

    const result = await recordRanking(work);

    expect(result.changed).toBe(true);
    // 種別の候補は、この作品で使った言葉から作る
    expect(picks[1].map((item) => item.label)).toEqual(
      expect.arrayContaining(["週間", "日間"])
    );
    // 順位は入力欄で受け、検証も通っている
    expect(asked[0].rejected).toBeUndefined();

    const saved = readLedger();
    expect(saved.rankings).toHaveLength(3);
    // **既にある記録は1つも変わらない**（追記だけ）
    expect(saved.rankings[0]).toEqual({
      site: "narou",
      recordedAt: "2026-09-01T00:00:00.000Z",
      board: "日間",
      rank: 30,
    });
    expect(saved.posts).toHaveLength(1);

    const added = saved.rankings[2];
    expect(added.site).toBe("narou");
    expect(added.board).toBe("日間");
    expect(added.rank).toBe(12);
    // 空のメモは持たせない
    expect(added.note).toBeUndefined();
    expect(typeof added.recordedAt).toBe("string");

    expect(informed.join("")).toContain("小説家になろう 日間 12位");
  });

  test("記録が1つも無ければ、種別は入力欄で訊く（空の候補を出さない）", async () => {
    writeLedger({
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: narouUrl }],
    });

    const picks = stubQuickPick([
      (items) => items.find((item) => item.site === "narou"),
    ]);
    stubInputs(["日間", "5", "更新直後"]);

    const result = await recordRanking(work);

    expect(result.changed).toBe(true);
    // 選択画面はサイトを選ぶ1回だけ
    expect(picks).toHaveLength(1);
    expect(readLedger().rankings[0]).toMatchObject({
      site: "narou",
      board: "日間",
      rank: 5,
      note: "更新直後",
    });
  });

  test("順位が数として読めなければ、記録しない", async () => {
    writeLedger({
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: narouUrl }],
    });
    const before = disk.get(ledgerPath);

    stubQuickPick([(items) => items.find((item) => item.site === "narou")]);
    const asked = stubInputs(["日間", "十二位"]);

    const result = await recordRanking(work);

    expect(result.changed).toBe(false);
    // 入力欄の検証が、その場で断っている
    expect(asked[1].rejected).toBeTruthy();
    expect(disk.get(ledgerPath)).toEqual(before);
  });
});
