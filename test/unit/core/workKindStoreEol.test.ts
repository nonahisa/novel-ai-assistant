import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";
import { writeWorkKind, invalidateWorkKind } from "../../../src/core/workKindStore";
import { writeWorkConfig } from "../../../src/core/workRegistry";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 作品の種類を変えても、設定ファイルの改行の形を変えない
 * （ノートPCの実機確認、2026-09-25）。
 *
 * 「作品の種類」を変えると `.aiwriter/config.json` が CRLF から LF に、
 * 末尾の改行も無くなっていた。**1項目を書き足しただけで全行が差分になる**
 * ——設定資料の保存で直した件（0.81.1、`jsonFileFormat.ts`）と同じ種類の
 * 問題で、設定ファイルを書く `writeWorkConfig` だけが取り残されていた。
 *
 * 本物のディスクの上で確かめる（`addCollectionConfig.test.ts` と同じ形）。
 * 読む側（`readWorkConfig`）は手元では Node の `fs` を直に使うので、
 * 代役の中だけで閉じたテストにはできない。
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
  schemaVersion: "1.0",
  workTitle: "改行の試験",
  manuscriptDir: "本文",
  settingsDir: "設定",
  createdAt: "2026-09-25T00:00:00.000Z",
};

async function placeConfig(text: string): Promise<void> {
  await fsp.mkdir(nodePath.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), text, "utf8");
}

async function readConfigText(): Promise<string> {
  return fsp.readFile(configPath(), "utf8");
}

/** 裸の LF（CR の付かない改行）があるか */
const hasBareLf = (text: string): boolean => /(?:^|[^\r])\n/.test(text);

beforeEach(async () => {
  base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-kind-eol-"));
  work = {
    id: `work_eol_${Math.random().toString(36).slice(2, 7)}`,
    title: "改行の試験",
    folderPath: nodePath.join(base, "改行の試験"),
    registeredAt: "2026-09-25T00:00:00.000Z",
  };
  installDiskFileSystem();
});

afterEach(async () => {
  invalidateWorkKind();
  workspace.fs = {} as typeof workspace.fs;
  await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
});

describe("種類を変えるとき、設定ファイルの改行を保つ", () => {
  test("CRLF・末尾に改行のあるファイルは、その形のまま書く（実機で崩れた形）", async () => {
    await placeConfig(
      `${JSON.stringify(baseConfig, null, 2)}\n`.replace(/\n/g, "\r\n")
    );

    await writeWorkKind(work, "essay");

    const written = await readConfigText();
    expect(written).toContain('"kind": "essay"');
    expect(hasBareLf(written)).toBe(false);
    expect(written.endsWith("}\r\n")).toBe(true);
  });

  test("LF・末尾に改行の無いファイルは、無いまま書く", async () => {
    await placeConfig(JSON.stringify(baseConfig, null, 2));

    await writeWorkKind(work, "script");

    const written = await readConfigText();
    expect(written).toContain('"kind": "script"');
    expect(written).not.toContain("\r");
    expect(written.endsWith("}")).toBe(true);
  });

  test("LF・末尾に改行のあるファイルは、改行を残す", async () => {
    await placeConfig(`${JSON.stringify(baseConfig, null, 2)}\n`);

    await writeWorkKind(work, "lyrics");

    const written = await readConfigText();
    expect(written).not.toContain("\r");
    expect(written.endsWith("}\n")).toBe(true);
  });
});

describe("設定ファイルが無いときは、これまでと同じ形で作る", () => {
  test("LF・末尾に改行なし（登録で作る設定ファイルを1バイトも変えない）", async () => {
    await writeWorkConfig(work, baseConfig);

    const written = await readConfigText();
    expect(written).toBe(JSON.stringify(baseConfig, null, 2));
  });
});
