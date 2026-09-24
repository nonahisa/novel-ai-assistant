import * as path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  commands,
  FileSystemError,
  Uri,
  window,
  workspace,
} from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「単話プロットを作る」を**実際に動かして**、既にある単話プロットを
 * 上書きしないことを見る（設計書6.36.2。実機確認リスト F-31 の代わり）。
 *
 * `episodePlotNoOverwrite.test.ts` は書き方の形（`mode: "create"` だけ・
 * 先に有無を確かめる）を見ている。そちらの断り書きのとおり、**既存の
 * ファイルが実際に残るか**は動かさないと分からないので、ここで動かす。
 * 無いときに雛形ができることも見る——片方だけだと「何もしない」実装でも通る。
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
}));

const { createEpisodePlot } = await import("../../../src/features/resumeWriting");

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const plotPath = Uri.file(
  path.join(work.folderPath, "設定", "episode-plots", "第3話.md")
).fsPath;

const disk = new Map<string, Uint8Array>();
let opened: unknown[][] = [];
let informed: string[] = [];
const originalExecute = commands.executeCommand;
const originalInfo = window.showInformationMessage;

const utf8 = (text: string) => new TextEncoder().encode(text);
const read = (key: string) => new TextDecoder().decode(disk.get(key));

beforeEach(() => {
  disk.clear();
  opened = [];
  informed = [];
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
    readDirectory: async () => [],
  } as unknown as typeof workspace.fs;
  (commands as { executeCommand?: unknown }).executeCommand = async (
    ...args: unknown[]
  ) => {
    opened.push(args);
    return undefined;
  };
  window.showInformationMessage = (async (message: string) => {
    informed.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
});

afterEach(() => {
  (commands as { executeCommand?: unknown }).executeCommand = originalExecute;
  window.showInformationMessage = originalInfo;
});

/** 開いたファイル（`vscode.open` に渡した場所） */
function openedPaths(): string[] {
  return opened
    .filter((args) => args[0] === "vscode.open")
    .map((args) => (args[1] as { fsPath: string }).fsPath);
}

describe("単話プロットを作る", () => {
  test("既にあれば、1文字も変えずにそのまま開く", async () => {
    const written = "# 第3話\n\n- 視点：灯\n- 作者が書いた展開\n";
    disk.set(plotPath, utf8(written));

    const created = await createEpisodePlot(work, 3);

    expect(created).toBe(false);
    expect(read(plotPath)).toBe(written);
    expect(openedPaths()).toEqual([plotPath]);
    expect(informed.join("\n")).toContain(
      "第3話の単話プロットは既にあります。そのまま開きました。"
    );
    // 退避も新規作成もしていない（ファイルは1つのまま）
    expect([...disk.keys()]).toEqual([plotPath]);
  });

  test("無ければ、雛形を作って開く", async () => {
    const created = await createEpisodePlot(work, 3);

    expect(created).toBe(true);
    expect(disk.has(plotPath)).toBe(true);
    const body = read(plotPath);
    expect(body).toContain("第3話");
    expect(body).toContain("視点");
    expect(openedPaths()).toEqual([plotPath]);
  });
});
