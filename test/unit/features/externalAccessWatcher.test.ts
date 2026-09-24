import { beforeEach, describe, expect, it } from "vitest";
import * as paths from "../../../src/core/paths";
import {
  FileSystemError,
  Uri,
  resetFileSystemWatchers,
  window,
  workspace,
} from "../support/vscodeStub";
import { ExternalAccessWatcher } from "../../../src/features/externalAccessWatcher";
import {
  EXTERNAL_ACCESS_DENIED_DETAIL,
  formatExternalAccessLine,
  type ExternalAccessEntry,
} from "../../../src/core/externalAccessLog";
import {
  formatExternalAccessPermission,
  parseExternalAccessPermission,
} from "../../../src/core/externalAccessPermission";
import type { WorkEntry } from "../../../src/models/types";
import type * as vscode from "vscode";

/**
 * 処理済みのノックを、別の窓が拾い直さない（設計書6.87.14）。
 *
 * **実機で起きた（2026-09-24）。** 開発ホストの窓Aで `schedule.milestones` の
 * ノックに「この道具だけ許可」（07:14）→「全部の道具を許可」（07:16）と
 * 答えたのに、10:48 に開いた窓Bの起動時に、**同じノックが「断りました」の
 * モーダルとしてもう一度出た。**
 *
 * 原因は2つ重なっていた。
 *
 * 1. 「見た」の覚え（`globalState`）を書くのが、**許可のあとに出す
 *    「いまの許可を見る」の知らせが閉じられてから**だった。VS Code の
 *    ボタン付きの知らせは、作者が閉じるまで返事を返さない（右下から
 *    消えても通知の一覧に残る）。だから押さずに放っておくと、**覚えが
 *    書かれないまま**になる
 * 2. 出す前に、**いまの許可の印を見ていなかった。** 許可済みの道具のノックを
 *    「断りました」と出すのは、作者から見れば事実と違う
 */

const WORK: WorkEntry = {
  id: "work-1",
  title: "たゆたう鉛_確認用",
  folderPath: "C:/作品/たゆたう鉛_確認用",
} as WorkEntry;

/** 製品が `paths.toUri()` で開くときと同じ形の鍵にする（ドライブ名の大小など） */
function diskKey(location: string): string {
  return Uri.file(location).fsPath;
}

const AIWRITER = paths.join(WORK.folderPath, ".aiwriter");
const LOG = diskKey(paths.join(AIWRITER, "history", "external.jsonl"));
const PERMISSION = diskKey(paths.join(AIWRITER, "external-access.json"));

const disk = new Map<string, Uint8Array>();

function knock(over: Partial<ExternalAccessEntry> = {}): ExternalAccessEntry {
  return {
    time: "2026-09-23T22:12:41.762Z",
    tool: "schedule.milestones",
    key: "schedule.milestones",
    client: "claude-code",
    file: "",
    exposure: "none",
    model: "",
    ok: false,
    detail: EXTERNAL_ACCESS_DENIED_DETAIL,
    ...over,
  };
}

function writeLog(entries: ExternalAccessEntry[]): void {
  disk.set(
    LOG,
    new TextEncoder().encode(
      entries.map((entry) => formatExternalAccessLine(entry)).join("\n") + "\n"
    )
  );
}

function writePermission(tools: string[]): void {
  disk.set(
    PERMISSION,
    new TextEncoder().encode(
      formatExternalAccessPermission({
        clients: [
          {
            name: "claude-code",
            tools,
            sampling: false,
            decidedAt: "2026-09-23T22:16:02.256Z",
            decidedOn: "GamingPC",
            note: "",
          },
        ],
        legacy: false,
      })
    )
  );
}

function readPermissionTools(): string[] {
  const bytes = disk.get(PERMISSION);
  if (!bytes) return [];
  return (
    parseExternalAccessPermission(new TextDecoder().decode(bytes)).clients[0]
      ?.tools ?? []
  );
}

/**
 * VS Code の `globalState` の代役。**窓どうしで共有される**（同じ機械の
 * 同じプロファイル）ので、2つの見張りに同じものを渡して「窓A・窓B」にする。
 */
function sharedGlobalState(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      (values.has(key) ? values.get(key) : defaultValue) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
    },
  } as vscode.Memento;
}

function contextWith(globalState: vscode.Memento): vscode.ExtensionContext {
  return { globalState } as unknown as vscode.ExtensionContext;
}

/** 見張りが裏で走らせた読み書きが落ち着くまで待つ */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 何回モーダル（断りましたの知らせ）が出たか */
let knockModals: string[] = [];

beforeEach(() => {
  disk.clear();
  resetFileSystemWatchers();
  knockModals = [];
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
  } as unknown as typeof workspace.fs;
  /*
    **許可のあとの「いまの許可を見る」は、作者が閉じるまで返事をしない**
    ——実機と同じく、ここでは永久に待たせる。
  */
  window.showInformationMessage = (() =>
    new Promise<undefined>(() => undefined)) as typeof window.showInformationMessage;
});

describe("処理済みのノックを、別の窓が拾い直さない", () => {
  it("**窓Aで「この道具だけ許可」と答えたら、あとで開いた窓Bには出ない**（許可のあとの知らせを放っておいても）", async () => {
    writeLog([knock()]);
    window.showWarningMessage = (async (message: string) => {
      knockModals.push(message);
      return "この道具だけ許可";
    }) as typeof window.showWarningMessage;

    const globalState = sharedGlobalState();
    const windowA = new ExternalAccessWatcher(
      contextWith(globalState),
      () => [WORK],
      () => undefined
    );
    windowA.refresh();
    await settle();
    expect(knockModals).toHaveLength(1);
    expect(readPermissionTools()).toEqual(["schedule.milestones"]);

    // 窓Bを開く（同じ機械なので globalState は共有される）
    const windowB = new ExternalAccessWatcher(
      contextWith(globalState),
      () => [WORK],
      () => undefined
    );
    windowB.refresh();
    await settle();
    expect(knockModals).toHaveLength(1);
    windowA.dispose();
    windowB.dispose();
  });

  it("**いまの許可の印で「全部」を許しているなら、覚えが無い窓でも出さない**", async () => {
    // 窓の覚えが何らかの理由で残っていなくても、許可の印が答えになる
    writeLog([knock()]);
    writePermission(["*"]);
    window.showWarningMessage = (async (message: string) => {
      knockModals.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;

    const watcher = new ExternalAccessWatcher(
      contextWith(sharedGlobalState()),
      () => [WORK],
      () => undefined
    );
    watcher.refresh();
    await settle();
    expect(knockModals).toEqual([]);
    watcher.dispose();
  });

  it("その道具だけを許しているときも出さない", async () => {
    writeLog([knock()]);
    writePermission(["schedule.milestones"]);
    window.showWarningMessage = (async (message: string) => {
      knockModals.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;

    const watcher = new ExternalAccessWatcher(
      contextWith(sharedGlobalState()),
      () => [WORK],
      () => undefined
    );
    watcher.refresh();
    await settle();
    expect(knockModals).toEqual([]);
    watcher.dispose();
  });

  it("**ほかの道具だけを許しているなら、まだ出す**（許可済みで絞りすぎない）", async () => {
    writeLog([knock()]);
    writePermission(["typo"]);
    window.showWarningMessage = (async (message: string) => {
      knockModals.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;

    const watcher = new ExternalAccessWatcher(
      contextWith(sharedGlobalState()),
      () => [WORK],
      () => undefined
    );
    watcher.refresh();
    await settle();
    expect(knockModals).toHaveLength(1);
    expect(knockModals[0]).toContain("schedule.milestones");
    watcher.dispose();
  });

  it("答えずに閉じた（Esc）ノックも、同じ窓・別の窓で繰り返さない", async () => {
    // 閉じたのも作者の判断。繰り返すと、作者は閉じることを覚えてしまう
    writeLog([knock()]);
    window.showWarningMessage = (async (message: string) => {
      knockModals.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;

    const globalState = sharedGlobalState();
    const windowA = new ExternalAccessWatcher(
      contextWith(globalState),
      () => [WORK],
      () => undefined
    );
    windowA.refresh();
    await settle();
    const windowB = new ExternalAccessWatcher(
      contextWith(globalState),
      () => [WORK],
      () => undefined
    );
    windowB.refresh();
    await settle();
    expect(knockModals).toHaveLength(1);
    windowA.dispose();
    windowB.dispose();
  });
});
