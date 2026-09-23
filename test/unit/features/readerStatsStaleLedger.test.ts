import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { READER_STATS_ENVELOPE_VERSION } from "../../../src/core/readerStatsEnvelope";
import { importReaderStats } from "../../../src/features/readerStats";
import { readPostingLedger, type PostingLedger } from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 2択を開いている間に、別の取り込みが台帳へ書いた（0.81.4）。
 *
 * ## 何が起きたか（実機、教科書チート_確認用 2026-09-22 12:07:10）
 *
 * 投稿状態の保存が「外部で変更されています」で止まった。その31秒前に、
 * 同じ機械でヘルパーからの読者の反応の取り込みが同じ `投稿状態.json` へ
 * 書いていた。読み取れる道は1つある——「読者の反応を貼り付けて取り込む」を
 * 押し、クリップボードが空で2択（管理画面を開く／クリップボードから取り込む）が
 * 出る。**この2択は焦点が外れても閉じない**ので、作者はブラウザでヘルパーの
 * 「読者の反応をコピー」を押す。ヘルパーの合図（URI）か、VS Code に戻ったときの
 * 取り込みが**先に同じ台帳へ書く**。戻って2択で「クリップボードから取り込む」を
 * 押すと、2択の前に読んだ古い台帳へ積んで保存しようとし、照合で止まる。
 *
 * **止める守りは正しい**（上書きすれば先の取り込みが消える）。直すのは、
 * 待ったあとに**読み直さない**ことのほう。2択のあとは台帳を読み直してから積む。
 * 読み直せば、先に取り込まれた分は「すでに取り込んだ数と同じ」と分かる。
 *
 * 数字・作品IDはすべて架空。
 */

const workId = "16816927859";

const work: WorkEntry = {
  id: "work_stale_ledger",
  title: "雨の日の図書館",
  folderPath: path.join("C:", "novels", "stale-ledger"),
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const envelope = JSON.stringify({
  "novelai-stats": READER_STATS_ENVELOPE_VERSION,
  site: "kakuyomu",
  workId,
  readAt: "2026-09-22T03:06:39.935Z",
  entries: [{ scope: "work", metrics: { points: 1612 } }],
});

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];

function storedLedger(): PostingLedger {
  return readPostingLedger(
    JSON.parse(new TextDecoder().decode(disk.get(ledgerPath)!))
  ).ledger;
}

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  env.clipboard.text = "";
  workspace.textDocuments = [];
  disk.set(
    ledgerPath,
    new TextEncoder().encode(
      `${JSON.stringify({
        schemaVersion: "1",
        sites: [],
        siteProfiles: [{ site: "kakuyomu", workId }],
        posts: [],
        rankings: [],
      })}\n`
    )
  );
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

describe("2択で待っている間に、同じ台帳へ別の取り込みが書いた", () => {
  test("読み直してから積むので、外部変更で止まらず、二重にも積まない", async () => {
    let asked = 0;
    Object.assign(window, {
      showQuickPick: async (items: Array<Record<string, unknown>>) => {
        asked++;
        // 2択を開いている間に、ヘルパーの合図から同じ封筒が取り込まれる
        await importReaderStats(work, { clipboardText: envelope });
        env.clipboard.text = envelope;
        // 戻ってきた作者が「クリップボードから取り込む」を押す
        return items.find((item) => item.open === false);
      },
    });

    await importReaderStats(work);

    expect(asked).toBe(1);
    // 「外部で変更されています」で止まらない
    expect(warned).toEqual([]);
    // 先の取り込みの1件だけが残る（2つ目は同じ数なので積まない）
    expect(storedLedger().readerStats).toHaveLength(1);
    expect(informed.at(-1)).toContain("すでに取り込んだ数と同じ");
  });
});
