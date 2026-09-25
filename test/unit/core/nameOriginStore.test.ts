import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";
import {
  readRememberedNameOrigin,
  rememberNameOrigin,
} from "../../../src/core/nameOriginStore";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 名前の系統を作品の設定（`.aiwriter/config.json` の `nameOrigin`）に覚える
 * （設計書6.37.2。作者の裁定、2026-09-25 昼）。
 *
 * 本物のディスクの上で確かめる（`workKindStoreEol.test.ts` と同じ形。
 * 読む側は手元では Node の `fs` を直に使う）。
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
  } as unknown as typeof workspace.fs;
}

const configPath = (): string =>
  nodePath.join(work.folderPath, ".aiwriter", "config.json");

const baseConfig = {
  schemaVersion: "0.1",
  workTitle: "ギルド",
  manuscriptDir: "本文",
  settingsDir: "設定",
  createdAt: "2026-09-25T00:00:00.000Z",
  kind: "novel",
};

async function placeConfig(text: string): Promise<void> {
  await fsp.mkdir(nodePath.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), text, "utf8");
}

beforeEach(async () => {
  base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-origin-"));
  work = {
    id: `work_origin_${Math.random().toString(36).slice(2, 7)}`,
    title: "ギルド",
    folderPath: nodePath.join(base, "ギルド"),
    registeredAt: "2026-09-25T00:00:00.000Z",
  };
  installDiskFileSystem();
});

afterEach(async () => {
  workspace.fs = {} as typeof workspace.fs;
  await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
});

describe("系統を覚える・読む", () => {
  test("覚えた系統を次に読める。ほかの項目（種類）は残る", async () => {
    await placeConfig(JSON.stringify(baseConfig, null, 2));

    expect(await readRememberedNameOrigin(work)).toBeUndefined();
    expect(await rememberNameOrigin(work, "ドイツ")).toEqual({ ok: true });
    expect(await readRememberedNameOrigin(work)).toBe("ドイツ");

    const written = JSON.parse(await fsp.readFile(configPath(), "utf8"));
    expect(written.kind).toBe("novel");
    expect(written.nameOrigin).toBe("ドイツ");
  });

  test("CRLF・末尾改行ありの設定ファイルは、その形のまま書く（jsonFileFormat）", async () => {
    await placeConfig(`${JSON.stringify(baseConfig, null, 2)}\n`.replace(/\n/g, "\r\n"));

    await rememberNameOrigin(work, "フランス");

    const text = await fsp.readFile(configPath(), "utf8");
    expect(text).toContain('"nameOrigin": "フランス"');
    expect(/(?:^|[^\r])\n/.test(text)).toBe(false);
    expect(text.endsWith("}\r\n")).toBe(true);
  });

  test("同じ系統なら書き直さない（更新時刻も中身も動かさない）", async () => {
    const original = JSON.stringify({ ...baseConfig, nameOrigin: "北欧" }, null, 2);
    await placeConfig(original);

    expect(await rememberNameOrigin(work, "北欧")).toEqual({ ok: true });
    expect(await fsp.readFile(configPath(), "utf8")).toBe(original);
  });

  test("設定ファイルが無ければ作らない（覚えられなかったと返す）", async () => {
    expect(await rememberNameOrigin(work, "ドイツ")).toEqual({ ok: false, reason: "missing" });
    await expect(fsp.stat(configPath())).rejects.toThrow();
  });

  test("壊れた設定ファイルは直さず、書かない（規則2）。読むときは覚えていないのと同じ", async () => {
    await placeConfig("{ 壊れている");

    const result = await rememberNameOrigin(work, "ドイツ");
    expect(result.ok).toBe(false);
    expect(await fsp.readFile(configPath(), "utf8")).toBe("{ 壊れている");
    expect(await readRememberedNameOrigin(work)).toBeUndefined();
  });
});
