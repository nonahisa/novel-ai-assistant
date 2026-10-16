import { vi } from "vitest";
import { FileSystemError, Position, Uri, workspace } from "./vscodeStub";

/**
 * 偽のディスク（メモリ上の Map）と、エディターで開いている文書の代役。
 *
 * **開いている文書へ当てて保存する道**（`core/openDocumentEdit.ts`）を、書き手ごとの
 * テストで同じ形で確かめるための部品。ディスクを「退避 → 消して作り直す」で書くと、
 * 開いたままのエディターが読み直す前に作者が打ったとき Ctrl+S が「ファイルのほうが
 * 新しい」で断られた（0.107.8、画面テスト plotRenamePending）。消したかどうか
 * （`deleted`）と、文書へ当てた文字列（`applied`）を見られるようにしてある。
 */
export interface FakeDisk {
  files: Map<string, Uint8Array>;
  /** ディスクから消したファイル（退避→作り直しの印） */
  deleted: string[];
  read(filePath: string): string | undefined;
  write(filePath: string, text: string): void;
}

export function installFakeDisk(): FakeDisk {
  const files = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  workspace.fs = {
    stat: async (uri: { fsPath: string }) => {
      if (!files.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
      return { type: 1, ctime: 0, mtime: 0, size: files.get(uri.fsPath)?.length ?? 0 };
    },
    createDirectory: async () => undefined,
    readFile: async (uri: { fsPath: string }) => {
      const bytes = files.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      files.set(uri.fsPath, bytes);
    },
    rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
      const bytes = files.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      files.set(to.fsPath, bytes);
      files.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      deleted.push(uri.fsPath);
      files.delete(uri.fsPath);
    },
  } as unknown as typeof workspace.fs;
  const key = (filePath: string) => Uri.file(filePath).fsPath;
  return {
    files,
    deleted,
    read: (filePath) => {
      const bytes = files.get(key(filePath));
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    },
    write: (filePath, text) => {
      files.set(key(filePath), new TextEncoder().encode(text));
    },
  };
}

export interface FakeOpenDocument {
  /** いまエディターに出ている中身（当てた分が入る） */
  text: string;
  dirty: boolean;
  /** 当てた文字列（`WorkspaceEdit.replace` に渡ったもの） */
  applied: string[];
  save: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
}

/**
 * `filePath` をエディターで開いた状態にする。中身は `text`（改行はそのまま）。
 *
 * 当て込み（`applyEdit`）は本物と同じく文書の中身を書き換える。保存（`save`）は
 * **ディスクへ書き、汚れを落とす**——VS Code が保存したときと同じ。
 */
export function openFakeDocument(
  disk: FakeDisk,
  filePath: string,
  text: string,
  options: { dirty?: boolean } = {}
): FakeOpenDocument {
  const state: FakeOpenDocument = {
    text,
    dirty: options.dirty ?? false,
    applied: [],
    save: vi.fn(async () => {
      disk.write(filePath, state.text);
      state.dirty = false;
      return true;
    }),
  };
  const offsetOf = (position: Position): number => {
    const lines = state.text.split("\n");
    let offset = 0;
    for (let index = 0; index < position.line; index += 1) offset += lines[index].length + 1;
    return offset + position.character;
  };
  workspace.textDocuments.push({
    uri: { fsPath: Uri.file(filePath).fsPath },
    get isDirty() {
      return state.dirty;
    },
    getText: () => state.text,
    save: () => state.save(),
    get eol() {
      return state.text.includes("\r\n") ? 2 : 1;
    },
    positionAt: (offset: number) => {
      const before = state.text.slice(0, offset).split("\n");
      return new Position(before.length - 1, before[before.length - 1].length);
    },
  } as unknown as (typeof workspace.textDocuments)[number]);
  workspace.applyEdit = async (edit: unknown) => {
    const replacements = (
      edit as { replacements: Array<{ range: { start: Position; end: Position }; text: string }> }
    ).replacements;
    for (const entry of replacements) {
      const start = offsetOf(entry.range.start);
      const end = offsetOf(entry.range.end);
      state.text = state.text.slice(0, start) + entry.text + state.text.slice(end);
      state.applied.push(entry.text);
    }
    if (replacements.length > 0) state.dirty = true;
    return true;
  };
  return state;
}
