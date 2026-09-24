import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { importReaderStats } from "../../../src/features/readerStats";
import { buildReaderStatsEnvelope } from "../../../src/core/readerStatsEnvelope";
import type { WorkEntry } from "../../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 読者の反応を取り込んだあとの知らせが、**作者が読む前に消える**（残課題9。
 * 2026-09-23 ノートPCの押し直し (d)「読者の反応の知らせは、別の知らせが
 * 下に出ると上へずれて、押す前に消えることがある」）。
 *
 * VS Code の右下の知らせ（トースト）は、ボタンが付いていても情報・警告なら
 * 時間がたつと通知センターへ沈み、新しい知らせが来ると古いものから画面を
 * 外れる。拡張機能の側から「消えない知らせ」は作れない。だからここで押さえる
 * のは次の3つである。
 *
 * - 取り込みの道が**自分で知らせを重ねない**（結果の知らせは1つ）
 * - 結果の中身（何件取り込んだか）が**操作ログにも残る**——画面から外れても読み返せる
 * - ボタン付きの断りを**待ち続けない**——待つと「読者の反応を取り込む」が
 *   動いたままになり、押し直すと「いま動いています」の知らせがもう1つ出る
 */

const work: WorkEntry = {
  id: "work_notice",
  title: "星を継ぐ者たち",
  folderPath: path.join("C:", "novels", "notice"),
  registeredAt: "2026-09-24T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

/** カクヨムに載っていると分かっている作品（作品IDは無い） */
const LEDGER = {
  schemaVersion: "1",
  sites: [],
  siteProfiles: [{ site: "kakuyomu", genre: "異世界ファンタジー" }],
  posts: [],
  rankings: [],
};

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];
const logged: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function envelope(pv: number): string {
  return buildReaderStatsEnvelope({
    site: "kakuyomu",
    readAt: "2026-09-24T10:00:00.000Z",
    entries: [{ scope: "work", metrics: { pv } }],
  });
}

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  logged.length = 0;
  env.clipboard.text = "";
  workspace.textDocuments = [];
  disk.set(ledgerPath, utf8(`${JSON.stringify(LEDGER, null, 2)}\n`));

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
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
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
    createOutputChannel: () => ({
      appendLine: (line: string) => logged.push(line),
      show() {},
      dispose() {},
    }),
  });
});

describe("取り込んだ結果の知らせ", () => {
  test("知らせは1つだけで、何件取り込んだかが入っている", async () => {
    env.clipboard.text = envelope(123456);

    const result = await importReaderStats(work);

    expect(result.changed).toBe(true);
    expect(warned).toEqual([]);
    expect(informed).toHaveLength(1);
    expect(informed[0]).toContain("1件 取り込みました");
  });

  test("**知らせが画面から外れても、同じ中身が操作ログに残る**", async () => {
    env.clipboard.text = envelope(123456);

    await importReaderStats(work);

    const log = logged.join("\n");
    expect(log).toContain("カクヨム の読者の反応を 1件 取り込みました");
  });

  /*
    実機確認リスト（0.83.12）の「操作ログに「〜件 取り込みました」と残るか」は、
    ファイル（作品の `.aiwriter/logs/actions.log`）で確かめると書いてある。
    上の試験は出力パネルの行を見ているので、ここでは**ファイルに書かれた行**を見る。
  */
  test("作品の .aiwriter/logs/actions.log に「〜件 取り込みました」の行が書かれる", async () => {
    env.clipboard.text = envelope(123456);

    await importReaderStats(work);

    const logFile = Uri.file(
      path.join(work.folderPath, ".aiwriter", "logs", "actions.log")
    ).fsPath;
    // 記録の書き込みは順番待ちの列で後から走るので、書かれるまで少し待つ
    let written = "";
    for (let attempt = 0; attempt < 50 && !written.includes("取り込みました"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const bytes = disk.get(logFile);
      written = bytes ? new TextDecoder().decode(bytes) : "";
    }
    expect(written).toContain("カクヨム の読者の反応を 1件 取り込みました");
  });

  test("同じ数だった回も、操作ログに残る", async () => {
    env.clipboard.text = envelope(123456);
    await importReaderStats(work);
    logged.length = 0;
    informed.length = 0;

    await importReaderStats(work);

    expect(informed).toHaveLength(1);
    expect(informed[0]).toContain("すでに取り込んだ数と同じ");
    expect(logged.join("\n")).toContain("すでに取り込んだ数と同じ");
  });
});

describe("ボタン付きの断りを待ち続けない", () => {
  test("封筒が無いときの［ヘルパーを入れる］が押されなくても、取り込みは戻る", async () => {
    // 押されないまま（通知センターへ沈んだまま）の知らせを真似る
    Object.assign(window, {
      showWarningMessage: (message: string) => {
        warned.push(message);
        return new Promise<undefined>(() => undefined);
      },
    });
    env.clipboard.text = "ただの文字列";

    const settled = await Promise.race([
      importReaderStats(work).then(() => "戻った"),
      new Promise((resolve) => setTimeout(() => resolve("待ち続けた"), 200)),
    ]);

    expect(settled).toBe("戻った");
    // 断りそのものは出ている（黙って戻ったのではない）
    expect(warned).toHaveLength(1);
  });
});
