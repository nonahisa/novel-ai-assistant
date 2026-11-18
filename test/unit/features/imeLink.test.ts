import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EventEmitter,
  FileSystemError,
  FileType,
  Uri,
  env,
  window,
  workspace,
} from "../support/vscodeStub";
import { startImeLink, type ImeLinkHandle } from "../../../src/features/imeCurrentWork";
import { hostTag } from "../../../src/core/runtime";
import { deriveWorkUid } from "../../../src/core/imeCurrentWork";
import type { WorkEntry } from "../../../src/models/types";

/**
 * オリジナルIME との連動（`startImeLink`）を、一時フォルダーの置き場で通す（設計書6.13.7）。
 *
 * **作者の %LOCALAPPDATA%\novel-ime には書かない**——置き場は必ず `stateDir` で
 * 一時フォルダーを渡す。
 */

let base: string;
let stateDir: string;
let work: WorkEntry;
let handle: ImeLinkHandle | undefined;
const pid = Number(hostTag());

const saved = {
  activeTextEditor: window.activeTextEditor,
  workspaceFolders: (workspace as Record<string, unknown>).workspaceFolders,
};

function installDiskFileSystem(): void {
  const notFound = (fsPath: string) => new FileSystemError(fsPath, "FileNotFound");
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
        throw notFound(uri.fsPath);
      }
    },
    readDirectory: async (uri: { fsPath: string }) => {
      try {
        const names = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return names.map((entry) => [
          entry.name,
          entry.isDirectory() ? FileType.Directory : FileType.File,
        ]);
      } catch {
        throw notFound(uri.fsPath);
      }
    },
    readFile: async (uri: { fsPath: string }) => {
      try {
        return new Uint8Array(await fsp.readFile(uri.fsPath));
      } catch {
        throw notFound(uri.fsPath);
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

let focused = true;
function installWindowState(): void {
  Object.assign(window, {
    state: {
      get focused() {
        return focused;
      },
    },
    onDidChangeWindowState: () => ({ dispose() {} }),
  });
  Object.assign(workspace, {
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: [],
  });
  Object.assign(env, { remoteName: undefined });
}

const configPath = (): string => nodePath.join(work.folderPath, ".aiwriter", "config.json");
const configText = JSON.stringify(
  {
    schemaVersion: "1.0",
    workTitle: "連動の試験",
    manuscriptDir: "本文",
    settingsDir: "設定",
    createdAt: "2026-11-16T00:00:00.000Z",
    // 知らない欄・形の悪い任意の欄も、番号を足したあとに残っていること
    futureField: { keep: true },
    announce: "形の悪い値",
  },
  null,
  2
);

const currentFile = (): string => nodePath.join(stateDir, "integration-current-work.json");
const worksFile = (): string => nodePath.join(stateDir, "integration-works.json");
const exists = async (file: string): Promise<boolean> =>
  fsp.stat(file).then(
    () => true,
    () => false
  );

function start(): ImeLinkHandle | undefined {
  const registry = {
    list: () => [work],
    onDidChange: new EventEmitter<void>().event,
  };
  const context = { subscriptions: [] as { dispose(): void }[] };
  return startImeLink(context as never, {
    registry,
    frontManuscript: () => undefined,
    onDidChangeFrontManuscript: () => ({ dispose() {} }),
    stateDir,
  });
}

beforeEach(async () => {
  base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "ime_"));
  stateDir = nodePath.join(base, "novel-ime");
  work = {
    id: "work_link",
    title: "連動の試験",
    folderPath: nodePath.join(base, "作品"),
  } as WorkEntry;
  await fsp.mkdir(nodePath.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), configText, "utf8");
  await fsp.mkdir(nodePath.join(work.folderPath, "本文"), { recursive: true });
  await fsp.writeFile(nodePath.join(work.folderPath, "本文", "001.txt"), "本文", "utf8");
  installDiskFileSystem();
  installWindowState();
  focused = true;
  window.activeTextEditor = {
    document: { uri: Uri.file(nodePath.join(work.folderPath, "本文", "001.txt")) },
  };
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  window.activeTextEditor = saved.activeTextEditor;
  Object.assign(workspace, { workspaceFolders: saved.workspaceFolders });
  await fsp.rm(base, { recursive: true, force: true });
});

describe("オリジナルIME との連動", () => {
  test("置き場が無ければ何も作らず、作品設定も変えない", async () => {
    handle = start();
    await handle?.close();
    expect(await exists(stateDir)).toBe(false);
    expect(await fsp.readFile(configPath(), "utf8")).toBe(configText);
    expect(await exists(nodePath.join(work.folderPath, ".aiwriter", "exports"))).toBe(false);
  });

  test("置き場があれば、一覧といまの作品を書き、番号だけを作品設定へ足す", async () => {
    await fsp.mkdir(stateDir);
    handle = start();
    await vi.waitFor(
      async () => {
        expect(await exists(currentFile())).toBe(true);
      },
      { timeout: 5000 }
    );
    const notice = JSON.parse(await fsp.readFile(currentFile(), "utf8"));
    const list = JSON.parse(await fsp.readFile(worksFile(), "utf8"));
    const config = JSON.parse(await fsp.readFile(configPath(), "utf8"));

    // 番号は createdAt から決まる（作者の決定 2026-11-17）
    expect(config.workUid).toBe(deriveWorkUid("2026-11-16T00:00:00.000Z"));
    expect(config.futureField).toEqual({ keep: true });
    expect(config.announce).toBe("形の悪い値");

    expect(notice.workUid).toBe(config.workUid);
    expect(notice.title).toBe("連動の試験");
    expect(notice.window).toBe(pid);
    // ふつうのエディターが前なので向きは分からない
    expect(notice.vertical).toBeNull();
    expect(notice.dictionaryHash).toMatch(/^sha256:/);
    expect(list.works.map((one: { workUid: string }) => one.workUid)).toEqual([config.workUid]);

    // 核向けの辞書（語の無い作品でも1行目だけはある）
    const tsv = await fsp.readFile(
      nodePath.join(work.folderPath, ".aiwriter", "exports", "ime", "novel-ime.tsv"),
      "utf8"
    );
    expect(tsv).toBe("#novel-ime-dictionary v1\n");

    // 閉じたら、この窓が書いた知らせを「作品なし」にする
    await handle?.close();
    handle = undefined;
    const closed = JSON.parse(await fsp.readFile(currentFile(), "utf8"));
    expect(closed.workUid).toBeNull();
    expect(closed.window).toBe(pid);
  });

  describe("置き場が2つ（novel-ime と rittoku-ime）の間", () => {
    const oldDir = (): string => nodePath.join(base, "novel-ime");
    const newDir = (): string => nodePath.join(base, "rittoku-ime");
    const startBoth = (): ImeLinkHandle | undefined => {
      const context = { subscriptions: [] as { dispose(): void }[] };
      return startImeLink(context as never, {
        registry: { list: () => [work], onDidChange: new EventEmitter<void>().event },
        frontManuscript: () => undefined,
        onDidChangeFrontManuscript: () => ({ dispose() {} }),
        stateDirs: [oldDir(), newDir()],
      });
    };
    const inDir = (dir: string, name: string): string => nodePath.join(dir, name);

    test("両方あれば、同じ中身を両方へ書き、閉じるときも両方を作品なしにする", async () => {
      await fsp.mkdir(oldDir());
      await fsp.mkdir(newDir());
      handle = startBoth();
      await vi.waitFor(
        async () => {
          expect(await exists(inDir(oldDir(), "integration-works.json"))).toBe(true);
          expect(await exists(inDir(newDir(), "integration-works.json"))).toBe(true);
          expect(await exists(inDir(oldDir(), "integration-current-work.json"))).toBe(true);
          expect(await exists(inDir(newDir(), "integration-current-work.json"))).toBe(true);
        },
        { timeout: 5000 }
      );
      const a = JSON.parse(await fsp.readFile(inDir(oldDir(), "integration-current-work.json"), "utf8"));
      const b = JSON.parse(await fsp.readFile(inDir(newDir(), "integration-current-work.json"), "utf8"));
      expect(a.workUid).toBeTruthy();
      expect(a.workUid).toBe(b.workUid);
      await handle?.close();
      handle = undefined;
      for (const dir of [oldDir(), newDir()]) {
        const closed = JSON.parse(await fsp.readFile(inDir(dir, "integration-current-work.json"), "utf8"));
        expect(closed.workUid).toBeNull();
      }
    });

    test("新しい方だけあれば新しい方だけ、古い方だけあれば古い方だけ。無い方は作らない", async () => {
      await fsp.mkdir(newDir());
      handle = startBoth();
      await vi.waitFor(
        async () => {
          expect(await exists(inDir(newDir(), "integration-current-work.json"))).toBe(true);
        },
        { timeout: 5000 }
      );
      await handle?.close();
      handle = undefined;
      expect(await exists(oldDir())).toBe(false);

      await fsp.rm(newDir(), { recursive: true });
      await fsp.mkdir(oldDir());
      handle = startBoth();
      await vi.waitFor(
        async () => {
          expect(await exists(inDir(oldDir(), "integration-current-work.json"))).toBe(true);
        },
        { timeout: 5000 }
      );
      await handle?.close();
      handle = undefined;
      expect(await exists(newDir())).toBe(false);
    });

    test("どちらも無ければ何も作らない", async () => {
      handle = startBoth();
      await handle?.close();
      handle = undefined;
      expect(await exists(oldDir())).toBe(false);
      expect(await exists(newDir())).toBe(false);
    });
  });

  describe("アプリ連動の口（連携\\novel-ai-assistant\\。設計書6.13.8）", () => {
    const oldDir = (): string => nodePath.join(base, "novel-ime");
    const newDir = (): string => nodePath.join(base, "rittoku-ime");
    const linkDir = (dir: string): string => nodePath.join(dir, "連携", "novel-ai-assistant");
    const startBoth = (): ImeLinkHandle | undefined => {
      const context = { subscriptions: [] as { dispose(): void }[] };
      return startImeLink(context as never, {
        registry: { list: () => [work], onDidChange: new EventEmitter<void>().event },
        frontManuscript: () => undefined,
        onDidChangeFrontManuscript: () => ({ dispose() {} }),
        stateDirs: [oldDir(), newDir()],
        appVersion: "9.8.7",
      });
    };
    const readJson = async (file: string): Promise<Record<string, unknown>> =>
      JSON.parse(await fsp.readFile(file, "utf8"));

    test("在る置き場すべての下に app.json・context.json・works.json を書き、前の形も書き続ける", async () => {
      await fsp.mkdir(oldDir());
      await fsp.mkdir(newDir());
      await fsp.writeFile(nodePath.join(work.folderPath, "本文", "001.txt"), "秘めた本文の字", "utf8");
      handle = startBoth();
      await vi.waitFor(
        async () => {
          for (const dir of [oldDir(), newDir()]) {
            for (const name of ["app.json", "context.json", "works.json"]) {
              expect(await exists(nodePath.join(linkDir(dir), name))).toBe(true);
            }
            expect(await exists(nodePath.join(dir, "integration-current-work.json"))).toBe(true);
            expect(await exists(nodePath.join(dir, "integration-works.json"))).toBe(true);
          }
        },
        { timeout: 5000 }
      );
      for (const dir of [oldDir(), newDir()]) {
        const app = await readJson(nodePath.join(linkDir(dir), "app.json"));
        expect(app).toMatchObject({
          v: 1,
          appId: "novel-ai-assistant",
          name: "統合小説執筆環境",
          processes: ["Code.exe"],
          version: "9.8.7",
        });
        const contextJson = await readJson(nodePath.join(linkDir(dir), "context.json"));
        const old = await readJson(nodePath.join(dir, "integration-current-work.json"));
        expect(contextJson.appId).toBe("novel-ai-assistant");
        const { appId: _appId, ...rest } = contextJson;
        void _appId;
        expect(rest).toEqual(old);
        const works = await readJson(nodePath.join(linkDir(dir), "works.json"));
        const oldWorks = await readJson(nodePath.join(dir, "integration-works.json"));
        expect(works.appId).toBe("novel-ai-assistant");
        expect(works.works).toEqual(oldWorks.works);
        // 本文は入らない（作品の本文の字が、どのファイルにも無い）
        for (const name of ["app.json", "context.json", "works.json"]) {
          expect(await fsp.readFile(nodePath.join(linkDir(dir), name), "utf8")).not.toContain("秘めた");
        }
      }

      // 閉じたら、この窓が書いた context.json も作品なしにする
      await handle?.close();
      handle = undefined;
      for (const dir of [oldDir(), newDir()]) {
        const closed = await readJson(nodePath.join(linkDir(dir), "context.json"));
        expect(closed.workUid).toBeNull();
        expect(closed.appId).toBe("novel-ai-assistant");
      }
    });

    test("置き場が無ければ連携のフォルダーも作らない", async () => {
      await fsp.mkdir(newDir());
      handle = startBoth();
      await vi.waitFor(
        async () => {
          expect(await exists(nodePath.join(linkDir(newDir()), "context.json"))).toBe(true);
        },
        { timeout: 5000 }
      );
      await handle?.close();
      handle = undefined;
      expect(await exists(oldDir())).toBe(false);
    });

    test("焦点の無い窓でも名乗り（app.json）は書く", async () => {
      await fsp.mkdir(newDir());
      focused = false;
      handle = startBoth();
      await vi.waitFor(
        async () => {
          expect(await exists(nodePath.join(linkDir(newDir()), "app.json"))).toBe(true);
        },
        { timeout: 5000 }
      );
      await handle?.close();
      handle = undefined;
      expect(await exists(nodePath.join(linkDir(newDir()), "context.json"))).toBe(false);
    });
  });

  test("焦点の無い窓は、いまの作品を書かない（一覧は書く）", async () => {
    await fsp.mkdir(stateDir);
    focused = false;
    handle = start();
    await vi.waitFor(
      async () => {
        expect(await exists(worksFile())).toBe(true);
      },
      { timeout: 5000 }
    );
    await handle?.close();
    handle = undefined;
    expect(await exists(currentFile())).toBe(false);
  });

  test("ほかの窓が書いた知らせは、閉じるときに消さない", async () => {
    await fsp.mkdir(stateDir);
    focused = false;
    const other = JSON.stringify({ v: 1, sender: "novel-ai-assistant", workUid: "x".repeat(10), window: pid + 1 });
    await fsp.writeFile(currentFile(), other, "utf8");
    handle = start();
    await handle?.close();
    handle = undefined;
    expect(await fsp.readFile(currentFile(), "utf8")).toBe(other);
  });
});
