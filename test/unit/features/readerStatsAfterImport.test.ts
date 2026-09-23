import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  importReaderStats,
  recordReaderStats,
} from "../../../src/features/readerStats";
import {
  buildReaderStatsEnvelope,
  matchReaderStatsEnvelope,
  parseReaderStatsEnvelope,
} from "../../../src/core/readerStatsEnvelope";
import { readPostingLedger } from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * ZIPから取り込んだ直後の作品で、**読者の反応の口が通るか**（設計書6.99／6.79.7）。
 *
 * 取り込みが書くのは `siteProfiles`（「この作品はカクヨムに載っている」）だけで
 * ある——バックアップに作品IDも投稿ページのURLも入っていないので、投稿先の
 * 登録（`sites`）は作れない。**その状態で口が通るのか**をここで測る。
 *
 * 「台帳を書いた」で終わらせると、**その先が使えないことに気づけない。**
 *
 * 作者の裁定（2026-09-19）：「siteProfiles も証拠と見る」。`sites` は
 * 「新規エピソード投稿ページのURLを貼ってある」ことしか意味しないので、
 * **そのサイトに載っている証拠**としては `siteProfiles` も同じ重さである。
 */

const work: WorkEntry = {
  id: "work_imported",
  title: "星を継ぐ者たち",
  folderPath: path.join("C:", "novels", "imported"),
  registeredAt: "2026-09-19T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

/** 取り込みが実際に書く台帳（`importWorkFromZip.test.ts` と同じ中身） */
const AFTER_IMPORT = {
  schemaVersion: "1",
  sites: [],
  siteProfiles: [{ site: "kakuyomu", genre: "異世界ファンタジー" }],
  posts: [],
  rankings: [],
};

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  env.clipboard.text = "";
  workspace.textDocuments = [];
  disk.set(ledgerPath, utf8(`${JSON.stringify(AFTER_IMPORT, null, 2)}\n`));

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
  });
});

/** 取り込み直後の台帳（読んだ形） */
function importedLedger() {
  return readPostingLedger(JSON.parse(new TextDecoder().decode(disk.get(ledgerPath)!)))
    .ledger;
}

describe("取り込んだ直後の作品で、読者の反応の口が通るか", () => {
  test("貼り付け：作品情報にそのサイトがあれば、突き合わせは通る", () => {
    const envelope = parseReaderStatsEnvelope(
      buildReaderStatsEnvelope({
        site: "kakuyomu",
        readAt: "2026-09-19T10:00:00.000Z",
        entries: [{ scope: "work", metrics: { pv: 123456 } }],
      })
    );
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;

    expect(
      matchReaderStatsEnvelope(envelope.envelope, importedLedger())
    ).toBeNull();
  });

  test("貼り付け：封筒を置けば、台帳に入る", async () => {
    env.clipboard.text = buildReaderStatsEnvelope({
      site: "kakuyomu",
      readAt: "2026-09-19T10:00:00.000Z",
      entries: [{ scope: "work", metrics: { pv: 123456 } }],
    });

    const result = await importReaderStats(work);

    expect(result.changed).toBe(true);
    expect(warned).toEqual([]);
    expect(importedLedger().readerStats).toHaveLength(1);
    expect(importedLedger().readerStats[0]).toMatchObject({
      site: "kakuyomu",
      scope: "work",
      metrics: { pv: 123456 },
      source: "helper",
    });
  });

  test("手入力：サイトを選ぶ画面まで進める", async () => {
    const titles: string[] = [];
    Object.assign(window, {
      showQuickPick: async (
        items: { label: string; site?: string }[],
        options: { title?: string }
      ) => {
        titles.push(options.title ?? "");
        return undefined;
      },
    });

    const result = await recordReaderStats(work);

    // 取りやめたので記録は増えないが、**断られてはいない**
    expect(result.changed).toBe(false);
    expect(warned).toEqual([]);
    expect(titles[0]).toContain(work.title);
  });

  test("手入力：選べるのは、載っていると分かっているサイトだけ", async () => {
    const labels: string[] = [];
    Object.assign(window, {
      showQuickPick: async (items: { label: string }[]) => {
        labels.push(...items.map((item) => item.label));
        return undefined;
      },
    });

    await recordReaderStats(work);

    // カクヨムは出る。載っていると分かっていないサイトは出ない
    expect(labels).toContain("カクヨム");
    expect(labels).not.toContain("小説家になろう");
  });

  /*
    **下ごしらえそのものは効いている**ことも一緒に見る。片方だけを見ると、
    「何も書いていない」実装でも上の検査は通ってしまう。
  */
  test("下ごしらえ：カクヨムに載っていることは台帳に残っている", () => {
    expect(importedLedger().siteProfiles).toEqual([
      { site: "kakuyomu", genre: "異世界ファンタジー" },
    ]);
  });
});
