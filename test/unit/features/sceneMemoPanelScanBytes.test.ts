import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 校正・メモパネルは、走査が読んだバイトから本文を作る（動作の高速化、2026-11-27）。
 *
 * 作品のファイルが変わるたびに、パネルは走査（`scanWork`）で全話を一度に読んだあと、
 * 全話を `vscode.workspace.fs` で1つずつ読み直していた。読み直しをやめても、
 * **パネルに出る付箋・知らせは前と同じ**でなければならない。
 *
 * ここでは本物の走査と本物の `readTextFile`／`decodeBytes` を通す（ほかの
 * `sceneMemoPanel*.test.ts` は走査を代役にしているので、この道を試さない）。
 * 改行が CRLF の話・Shift_JIS の話・BOM 付きの話・競合の残る話・読めない話を並べる。
 */

const files = new Map<string, Uint8Array>();
/** 読めない話（走査の一括読みでも、`workspace.fs` でも失敗する） */
const unreadable = new Set<string>();
/** 本文の話を `vscode.workspace.fs.readFile` で読んだ回数 */
const episodeReads: string[] = [];
const posted: Array<{ type: string; data?: Record<string, unknown> }> = [];

vi.mock("../../../src/core/memoMarkerStore", () => import("../support/memoMarkerStoreStub"));

vi.mock("vscode", async () => {
  const stub = await import("../support/vscodeStub");
  const noop = () => undefined;
  return {
    ...stub,
    ViewColumn: { One: 1, Beside: -2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
    commands: { executeCommand: vi.fn() },
    window: {
      ...stub.window,
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      activeTextEditor: undefined,
      activeColorTheme: { kind: 1 },
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
      createWebviewPanel: () => ({
        webview: {
          html: "",
          cspSource: "vscode-webview:",
          onDidReceiveMessage: () => ({ dispose: noop }),
          postMessage: (message: { type: string; data?: Record<string, unknown> }) => {
            posted.push(message);
            return Promise.resolve(true);
          },
        },
        onDidDispose: () => ({ dispose: noop }),
        reveal: noop,
        dispose: noop,
      }),
    },
    workspace: {
      ...stub.workspace,
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: {
        readFile: vi.fn(async (uri: { fsPath: string }) => {
          if (uri.fsPath.endsWith(".txt")) episodeReads.push(uri.fsPath);
          // 代役の `Uri.fsPath` はドライブ文字を小文字にするので、大小を見ずに引く
          const key = [...files.keys()].find((name) => name.toLowerCase() === uri.fsPath.toLowerCase());
          const bytes = key === undefined ? undefined : files.get(key);
          if (!bytes || key === undefined || unreadable.has(key)) {
            throw new stub.FileSystemError("無い", "FileNotFound");
          }
          return bytes;
        }),
        writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
          files.set(uri.fsPath, bytes);
        }),
        createDirectory: vi.fn(async () => undefined),
        stat: vi.fn(async () => {
          throw new stub.FileSystemError("無い", "FileNotFound");
        }),
        readDirectory: vi.fn(async () => []),
        delete: vi.fn(async () => undefined),
        rename: vi.fn(async () => undefined),
      },
    },
  };
});

vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: vi.fn(async () => undefined),
}));

vi.mock("../../../src/features/manuscriptEditor", () => ({
  lastManuscriptCaret: () => undefined,
  removeMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "not_open" })),
  restoreMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "not_open" })),
}));

vi.mock("../../../src/features/revealLocation", () => ({
  revealTextLocation: vi.fn(async () => undefined),
}));

vi.mock("../../../src/views/openDocument", () => ({
  openGeneratedMarkdown: vi.fn(async () => undefined),
}));

import * as nodePath from "node:path";
import { openSceneMemoPanel } from "../../../src/features/sceneMemoPanel";
import { setFileReaderForTests, vscodeFileReaderForTests, type FileReader } from "../../../src/core/fileRead";
import type { WorkEntry } from "../../../src/models/types";
import { absPath } from "../support/osPath";

const WORK_FOLDER = absPath("小説", "速さの作品");
const BODY_DIR = nodePath.join(WORK_FOLDER, "本文");
const at = (name: string): string => nodePath.join(BODY_DIR, name);

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * 走査の読み口の代役。本文の置き場は上の `files` と同じ（`workspace.fs` と食い違わない）。
 * `readTextTree` は本物と同じく名前順に並べ、読めない話は `unreadable` を立てて残す。
 */
const reader: FileReader = {
  async readFile(filePath) {
    const bytes = files.get(filePath);
    if (!bytes) throw Object.assign(new Error("無い"), { code: "ENOENT" });
    return bytes;
  },
  async stat(filePath) {
    if (filePath === BODY_DIR) return { type: "directory", size: 0, mtime: 0 };
    if (files.has(filePath)) return { type: "file", size: 0, mtime: 0 };
    throw Object.assign(new Error("無い"), { code: "ENOENT" });
  },
  async readDirectory(dirPath) {
    if (dirPath !== BODY_DIR) return [];
    return [...files.keys()]
      .filter((key) => nodePath.dirname(key) === BODY_DIR)
      .map((key) => [nodePath.basename(key), "file"] as [string, "file"]);
  },
  async readTextTree(dirPath, accept) {
    if (dirPath !== BODY_DIR) return [];
    return [...files.keys()]
      .filter((key) => nodePath.dirname(key) === BODY_DIR)
      .sort()
      .filter((key) => accept(nodePath.basename(key), "file", key))
      .map((key) =>
        unreadable.has(key)
          ? { path: key, bytes: new Uint8Array(0), unreadable: true }
          : { path: key, bytes: files.get(key) as Uint8Array }
      );
  },
};

let workCount = 0;
function newWork(): WorkEntry {
  workCount += 1;
  return { id: `scan-bytes-${workCount}`, title: "速さの作品", folderPath: WORK_FOLDER, registeredAt: "2026-11-27T00:00:00.000Z" };
}

const context = { subscriptions: [] as unknown[] };

async function openPanel(): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await openSceneMemoPanel(context as any, newWork(), {});
  const memos = posted.filter((message) => message.type === "memos");
  return (memos[memos.length - 1]?.data ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  files.clear();
  unreadable.clear();
  episodeReads.length = 0;
  posted.length = 0;
  setFileReaderForTests(reader);

  // 改行が CRLF の話。付箋の行と中身は LF に揃えた本文で決まる
  files.set(at("001.txt"), utf8("一の一行目。\r\n// 一のメモ\r\n一の三行目。\r\n"));
  // Shift_JIS の話（「あいう。」「// メモ」）。UTF-8 としては読めない並び
  files.set(
    at("002.txt"),
    new Uint8Array([
      0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x81, 0x42, 0x0a, 0x2f, 0x2f, 0x20, 0x83, 0x81, 0x83, 0x82, 0x0a,
    ])
  );
  // BOM 付きの話。BOM は付箋の中身に入らない
  files.set(at("003.txt"), new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("三の一行目。\n三の二行目。\n// 三のメモ\n")]));
  // 競合の残る話は読まない（付箋を出さず、知らせを出す）
  files.set(at("004.txt"), utf8("<<<<<<< HEAD\n// 四のメモ\n=======\n四。\n>>>>>>> main\n"));
  // 読めない話は、知らせを出して飛ばす
  files.set(at("005.txt"), utf8("// 五のメモ\n"));
  unreadable.add(at("005.txt"));
});

describe("走査が読んだバイトから付箋を作っても、パネルの中身は変わらない", () => {
  test("CRLF・Shift_JIS・BOM の話の付箋が、話の順・行・中身どおりに出る", async () => {
    try {
      const data = await openPanel();
      const rows = (data.rows ?? []) as Array<Record<string, unknown>>;
      expect(rows.map((row) => [row.kind, nodePath.basename(String(row.filePath)), row.line, row.text])).toEqual([
        ["memo", "001.txt", 2, "一のメモ"],
        ["memo", "002.txt", 2, "メモ"],
        ["memo", "003.txt", 3, "三のメモ"],
      ]);
      // 生の行も LF に揃えた本文から切る（CR が残らない）
      expect(rows[0].raw).toBe("// 一のメモ");
    } finally {
      setFileReaderForTests(vscodeFileReaderForTests());
    }
  });

  test("競合の残る話・読めない話の知らせは、前と同じ文で出る", async () => {
    try {
      const data = await openPanel();
      expect(String(data.notice)).toContain("004.txt は未解決の競合を含むため読みません。");
      expect(String(data.notice)).toContain("005.txt を読めませんでした。");
    } finally {
      setFileReaderForTests(vscodeFileReaderForTests());
    }
  });

  test("読めた話は workspace.fs で読み直さない（読めなかった話だけ読み直して確かめる）", async () => {
    try {
      await openPanel();
      expect(episodeReads.map((p) => nodePath.basename(p))).toEqual(["005.txt"]);
    } finally {
      setFileReaderForTests(vscodeFileReaderForTests());
    }
  });
});
