import { afterEach, beforeEach, describe, expect, it } from "vitest";
// 差し替え口はスタブから直に取る（`importWorkFromZip.test.ts` と同じ理由：
// `"vscode"` から取ると `workspace.fs` が読み取り専用の型になる）
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";
import type * as vscode from "vscode";
import {
  BACKUP_PICK_FOLDER_KEY,
  initBackupPickFolder,
  showBackupOpenDialog,
} from "../../../src/features/backupPickFolder";

/**
 * バックアップを選ぶ画面を、前に選んだフォルダーから開く（2026-09-23）。
 *
 * 作者は展開したなろうの `.txt` を何作ぶんも続けて渡す。毎回同じ作品
 * フォルダーから開き直すと、そのたびに辿り直すことになる。
 */

const PICKED = "C:\\Users\\a\\小説\\短編\\N4190FX.txt";
const FOLDER = "C:\\Users\\a\\小説\\短編";

class FakeMemento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

const original = { showOpenDialog: window.showOpenDialog, fs: workspace.fs };
/** 画面へ渡された `defaultUri`（開くたびに積む） */
let opened: Array<vscode.Uri | undefined> = [];
/** 実際にある場所 */
let existing = new Set<string>();

function stubDialog(pick: string | undefined): void {
  (window as unknown as Record<string, unknown>).showOpenDialog = async (
    options?: vscode.OpenDialogOptions
  ) => {
    opened.push(options?.defaultUri);
    return pick ? [Uri.file(pick)] : undefined;
  };
}

beforeEach(() => {
  opened = [];
  existing = new Set([FOLDER, Uri.file(FOLDER).fsPath]);
  workspace.fs = {
    stat: async (uri: { fsPath: string }) => {
      if (!existing.has(uri.fsPath)) {
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      }
      return { type: 2 };
    },
  } as unknown as typeof workspace.fs;
});

afterEach(() => {
  (window as unknown as Record<string, unknown>).showOpenDialog =
    original.showOpenDialog;
  workspace.fs = original.fs;
});

describe("前に選んだフォルダーから開く", () => {
  it("はじめは既定を出さない（VS Code 任せ）", async () => {
    initBackupPickFolder(new FakeMemento() as unknown as vscode.Memento);
    stubDialog(PICKED);

    await showBackupOpenDialog({ canSelectFiles: true });

    expect(opened).toEqual([undefined]);
  });

  it("選んだファイルのフォルダーを覚え、次はそこから開く", async () => {
    const memento = new FakeMemento();
    initBackupPickFolder(memento as unknown as vscode.Memento);
    stubDialog(PICKED);

    const first = await showBackupOpenDialog({ canSelectFiles: true });
    await showBackupOpenDialog({ canSelectFiles: true });

    expect(first?.fsPath).toBe(Uri.file(PICKED).fsPath);
    // 本物と同じく、ドライブ名は小文字で戻ってくる（fsPath の形）
    expect(memento.get(BACKUP_PICK_FOLDER_KEY)).toBe(Uri.file(FOLDER).fsPath);
    expect(opened[1]?.fsPath).toBe(Uri.file(FOLDER).fsPath);
  });

  it("選ばずに閉じたときは、覚えている場所を変えない", async () => {
    const memento = new FakeMemento();
    memento.values.set(BACKUP_PICK_FOLDER_KEY, FOLDER);
    initBackupPickFolder(memento as unknown as vscode.Memento);
    stubDialog(undefined);

    expect(await showBackupOpenDialog({ canSelectFiles: true })).toBeUndefined();
    expect(memento.get(BACKUP_PICK_FOLDER_KEY)).toBe(FOLDER);
  });

  it("覚えた場所が今は無ければ、既定を出さない", async () => {
    const memento = new FakeMemento();
    memento.values.set(BACKUP_PICK_FOLDER_KEY, "C:\\消したフォルダー");
    initBackupPickFolder(memento as unknown as vscode.Memento);
    stubDialog(undefined);

    await showBackupOpenDialog({ canSelectFiles: true });

    expect(opened).toEqual([undefined]);
  });

  it("ブラウザ版の場所（vscode-vfs:）も、そのまま覚えて戻せる", async () => {
    const memento = new FakeMemento();
    initBackupPickFolder(memento as unknown as vscode.Memento);
    const remote = "vscode-vfs://github/owner/repo/短編/N4190FX.txt";
    (window as unknown as Record<string, unknown>).showOpenDialog = async () => [
      Uri.parse(remote),
    ];

    await showBackupOpenDialog({ canSelectFiles: true });

    expect(memento.get(BACKUP_PICK_FOLDER_KEY)).toBe(
      "vscode-vfs://github/owner/repo/短編"
    );
  });
});
