import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";
import {
  ensureWorkUid,
  imeTsvFile,
  writeImeTsv,
} from "../../../src/features/imeCurrentWork";
import { writeWorkConfig, readWorkConfig } from "../../../src/core/workRegistry";
import { IME_TSV_HEADER } from "../../../src/core/imeCurrentWork";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 作品の番号（workUid）を作品設定へ足す・核向けの辞書を書く（設計書6.13.7）。
 *
 * 本物のディスクの一時フォルダーで確かめる（`workKindStoreEol.test.ts` と同じ形）。
 * 作者の %LOCALAPPDATA%\novel-ime には触らない（置き場へ書く部分はここでは試さない）。
 */

let base: string;
let work: WorkEntry;

function installDiskFileSystem(): void {
  workspace.fs = {
    createDirectory: async (uri: { fsPath: string }) => {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    stat: async (uri: { fsPath: string }) => {
      try {
        const stat = await fsp.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      } catch {
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      }
    },
    readFile: async (uri: { fsPath: string }) => {
      try {
        return new Uint8Array(await fsp.readFile(uri.fsPath));
      } catch {
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      }
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await fsp.writeFile(uri.fsPath, bytes);
    },
    rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
      await fsp.rename(from.fsPath, to.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      await fsp.rm(uri.fsPath, { force: true });
    },
  } as unknown as typeof workspace.fs;
}

const configPath = (): string => nodePath.join(work.folderPath, ".aiwriter", "config.json");

const baseConfig = {
  schemaVersion: "1.0",
  workTitle: "番号の試験",
  manuscriptDir: "本文",
  settingsDir: "設定",
  createdAt: "2026-11-16T00:00:00.000Z",
};

async function placeConfig(text: string): Promise<void> {
  await fsp.mkdir(nodePath.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), text, "utf8");
}

const UID_A = "11111111-2222-3333-4444-555555555555";
const UID_B = "99999999-8888-7777-6666-555555555555";

beforeEach(async () => {
  base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "ime_"));
  work = {
    id: "work_test",
    title: "番号の試験",
    folderPath: nodePath.join(base, "作品"),
  } as WorkEntry;
  installDiskFileSystem();
});

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true });
});

describe("作品の番号を足す（ensureWorkUid）", () => {
  test("無ければ足す。ほかの欄と改行の形はそのまま", async () => {
    const original = JSON.stringify(baseConfig, null, 2).replace(/\n/g, "\r\n") + "\r\n";
    await placeConfig(original);
    const result = await ensureWorkUid(work, { allowAdd: true, newUid: () => UID_A });
    expect(result).toEqual({ kind: "ready", workUid: UID_A, added: true });
    const text = await fsp.readFile(configPath(), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.workUid).toBe(UID_A);
    expect(parsed.workTitle).toBe("番号の試験");
    // CRLF のファイルは CRLF のまま（1項目を足しただけで全行が差分にならない）
    expect(/(?:^|[^\r])\n/.test(text)).toBe(false);
  });

  test("既にある番号は変えない", async () => {
    const original = JSON.stringify({ ...baseConfig, workUid: UID_A }, null, 2);
    await placeConfig(original);
    const result = await ensureWorkUid(work, { allowAdd: true, newUid: () => UID_B });
    expect(result).toEqual({ kind: "ready", workUid: UID_A, added: false });
    expect(await fsp.readFile(configPath(), "utf8")).toBe(original);
  });

  test("壊れた JSON は直さず止める（1バイトも変えない）", async () => {
    const broken = '{ "schemaVersion": "1.0", "workTitle": ';
    await placeConfig(broken);
    const result = await ensureWorkUid(work, { allowAdd: true, newUid: () => UID_B });
    expect(result.kind).toBe("stopped");
    expect(await fsp.readFile(configPath(), "utf8")).toBe(broken);
  });

  test("形の悪い番号は書き換えずに止める", async () => {
    const original = JSON.stringify({ ...baseConfig, workUid: "..\\学習" }, null, 2);
    await placeConfig(original);
    const result = await ensureWorkUid(work, { allowAdd: true, newUid: () => UID_B });
    expect(result.kind).toBe("stopped");
    expect(await fsp.readFile(configPath(), "utf8")).toBe(original);
  });

  test("作品設定が無ければ作らない", async () => {
    const result = await ensureWorkUid(work, { allowAdd: true, newUid: () => UID_B });
    expect(result.kind).toBe("stopped");
    await expect(fsp.stat(configPath())).rejects.toThrow();
  });

  test("編集者モード（足してはいけない）なら足さない", async () => {
    const original = JSON.stringify(baseConfig, null, 2);
    await placeConfig(original);
    const result = await ensureWorkUid(work, { allowAdd: false, newUid: () => UID_B });
    expect(result.kind).toBe("stopped");
    expect(await fsp.readFile(configPath(), "utf8")).toBe(original);
  });

  test("足したあと、ほかの欄を書き直しても番号が残る", async () => {
    await placeConfig(JSON.stringify(baseConfig, null, 2));
    await ensureWorkUid(work, { allowAdd: true, newUid: () => UID_A });
    const config = await readWorkConfig(work);
    expect(config?.workUid).toBe(UID_A);
    await writeWorkConfig(work, { ...config!, workTitle: "改題" });
    const parsed = JSON.parse(await fsp.readFile(configPath(), "utf8"));
    expect(parsed.workTitle).toBe("改題");
    expect(parsed.workUid).toBe(UID_A);
  });
});

describe("核向けの辞書を書く（writeImeTsv）", () => {
  test("作品の .aiwriter/exports/ime/ に BOM 無し・LF で書き、ハッシュを返す", async () => {
    const text = `${IME_TSV_HEADER}\n聖言\tせいげん\tterm\t\n`;
    const hash = await writeImeTsv(work, text);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const file = imeTsvFile(work);
    expect(file).toBe(
      nodePath.join(work.folderPath, ".aiwriter", "exports", "ime", "novel-ime.tsv")
    );
    const bytes = await fsp.readFile(file);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe(text);
    // 同じ中身なら同じハッシュ（書き直さない）
    expect(await writeImeTsv(work, text)).toBe(hash);
  });
});
