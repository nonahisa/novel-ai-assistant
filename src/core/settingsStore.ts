import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import { hashBytes } from "./textFile";
import { atomicWriteFile, AtomicWriteFileError } from "./atomicWrite";

/**
 * 能力・場所のような「1件1ファイル」の設定を保存する汎用ストア。
 *
 * 人物設定（characterStore）と同じ保護を課す。
 *   - 読み込み時のハッシュを覚え、外部で変更されていたら書き込まない
 *   - エディタに未保存の変更があれば書き込まない
 *   - 壊れたJSONを勝手に修復・上書きしない
 *   - ファイル名とIDの不一致・ID重複を検出する
 *
 * 作者はこれらのJSONを直接編集する。AIの再生成で
 * その編集を踏み潰さないことが最優先である。
 */

export type SettingsStoreErrorKind =
  | "modified_externally"
  | "path_conflict"
  | "unsaved_changes"
  | "io_error";

export class SettingsStoreError extends Error {
  constructor(
    message: string,
    readonly kind: SettingsStoreErrorKind,
    readonly recoveryPaths: string[] = []
  ) {
    super(message);
    this.name = "SettingsStoreError";
  }
}

interface Snapshot {
  filePath: string;
  hash: string;
}

/** 保存対象の型が満たすべき最小限の形 */
export interface StorableRecord {
  id: string;
  name: string;
  updatedAt: string;
}

export interface SettingsStoreOptions<T extends StorableRecord> {
  /** 設定フォルダ配下のディレクトリ名（"abilities" 等） */
  directoryName: string;
  /** IDの形式（"abil" 等）。ファイル名との整合性検査に使う */
  idPrefix: string;
  /** 作者が編集したJSONを検証する。壊れていれば例外を投げる */
  parse: (raw: unknown) => T;
  /** ファイル名を決める */
  fileName: (record: T) => string;
}

export class SettingsStore<T extends StorableRecord> {
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(
    private readonly work: WorkEntry,
    private readonly options: SettingsStoreOptions<T>
  ) {}

  /**
   * 保存先のフォルダ名。
   *
   * 外部の変更を見張る側（`externalChanges.ts`）が、
   * 実際の保存先と対応表がずれていないかを確かめるために使う。
   */
  get directoryName(): string {
    return this.options.directoryName;
  }

  private async dir(): Promise<string> {
    const config = await readWorkConfig(this.work);
    return path.join(
      workPaths(this.work, config).settings,
      this.options.directoryName
    );
  }

  async ensureDir(): Promise<string> {
    const directory = await this.dir();
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
    return directory;
  }

  /** 全件を読み込む。壊れたJSONは読み飛ばし、エラーとして返す */
  async loadAll(): Promise<{
    records: T[];
    errors: Array<{ file: string; message: string }>;
  }> {
    this.snapshots.clear();
    const directory = await this.dir();
    const records: T[] = [];
    const errors: Array<{ file: string; message: string }> = [];
    const loadedIds = new Set<string>();
    const loadedSnapshots = new Map<string, Snapshot>();

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(directory)
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return { records, errors };
      }
      throw error;
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      if (!name.endsWith(".json")) continue;
      if (name.startsWith("_")) continue;

      const full = path.join(directory, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.file(full)
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const record = this.options.parse(parsed);
        if (
          name !== `${record.id}.json` &&
          !name.startsWith(`${record.id}_`)
        ) {
          throw new Error(`ファイル名とID「${record.id}」が一致しません。`);
        }
        if (loadedIds.has(record.id)) {
          loadedSnapshots.delete(record.id);
          throw new Error(`ID「${record.id}」が重複しています。`);
        }
        loadedIds.add(record.id);
        records.push(record);
        loadedSnapshots.set(record.id, {
          filePath: full,
          hash: hashBytes(bytes),
        });
      } catch (e) {
        // 作者が手で編集して壊れた可能性がある。
        // 勝手に修復・上書きせず、エラーとして報告する。
        errors.push({
          file: name,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    for (const [id, snapshot] of loadedSnapshots) {
      this.snapshots.set(id, snapshot);
    }
    records.sort((a, b) => a.id.localeCompare(b.id));
    return { records, errors };
  }

  /** このディレクトリ内で、作者がまだ保存していないJSONを返す */
  async dirtyDocumentPaths(): Promise<string[]> {
    const directory = await this.dir();
    return vscode.workspace.textDocuments
      .filter((document) => {
        const filePath = document.uri.fsPath;
        return (
          document.isDirty &&
          path.extname(filePath).toLowerCase() === ".json" &&
          isPathInside(directory, filePath)
        );
      })
      .map((document) => document.uri.fsPath);
  }

  async saveAll(records: T[]): Promise<void> {
    const requestedIds = new Set<string>();
    for (const record of records) {
      if (requestedIds.has(record.id)) {
        throw new SettingsStoreError(
          `ID「${record.id}」が保存対象内で重複しています。`,
          "path_conflict"
        );
      }
      requestedIds.add(record.id);
    }

    // 途中まで書いて止まらないよう、書き込み前に全件を検証する
    const unsaved = await this.dirtyDocumentPaths();
    if (unsaved.length > 0) {
      throw new SettingsStoreError(
        "未保存の変更があるため保存しませんでした。",
        "unsaved_changes",
        unsaved
      );
    }
    for (const record of records) {
      await this.assertSaveAllowed(record);
    }

    const directory = await this.ensureDir();
    for (const record of records) {
      const fileName = this.options.fileName(record);
      const target = path.join(directory, fileName);
      const body =
        JSON.stringify(
          { ...record, updatedAt: new Date().toISOString() },
          null,
          2
        ) + "\n";

      try {
        await atomicWriteFile(target, new TextEncoder().encode(body));
      } catch (error) {
        if (error instanceof AtomicWriteFileError) {
          throw new SettingsStoreError(
            `「${record.name}」の保存に失敗しました。${error.message}`,
            "io_error",
            error.recoveryPaths ?? []
          );
        }
        throw error;
      }

      // 名前が変わった場合、古いファイルが残らないよう削除する。
      // **同じファイルかどうかは文字列比較では決まらない。**
      // Windowsは大文字小文字を区別しないので、`Fire`→`fire` の改名では
      // 書き込み先と「古いファイル」が同じ1つのファイルになる。
      // 文字列で比べると別物に見えて、今書いたものを消してしまう
      const previous = this.snapshots.get(record.id);
      if (previous && !isSamePath(previous.filePath, target)) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(previous.filePath));
        } catch {
          // 消せなくても新規保存は済んでいる。次回の読み込みで重複IDとして検出される
        }
      }
      this.snapshots.set(record.id, {
        filePath: target,
        hash: hashBytes(new TextEncoder().encode(body)),
      });
    }
  }

  /**
   * 読み込み後に外部から変更されていないか確認する。
   * AI応答には時間がかかり、その間に作者や他のツールが
   * ファイルを書き換えている可能性があるため。
   */
  private async assertSaveAllowed(record: T): Promise<void> {
    const snapshot = this.snapshots.get(record.id);
    if (!snapshot) return; // 新規レコードは競合しようがない

    let current: Uint8Array;
    try {
      current = await vscode.workspace.fs.readFile(
        vscode.Uri.file(snapshot.filePath)
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        // 読み込み後に削除された。作者の意図かもしれないので上書きしない
        throw new SettingsStoreError(
          `「${record.name}」は読み込み後に削除されました。`,
          "modified_externally",
          [snapshot.filePath]
        );
      }
      throw error;
    }

    if (hashBytes(current) !== snapshot.hash) {
      throw new SettingsStoreError(
        `「${record.name}」は読み込み後に変更されました。作者の変更を保護するため保存しませんでした。`,
        "modified_externally",
        [snapshot.filePath]
      );
    }
  }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = normalizePathForComparison(parentPath);
  const candidate = normalizePathForComparison(candidatePath);
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 同じファイルを指すパスか。
 *
 * Windowsは大文字小文字を区別しないため、文字列が違っても
 * 同じファイルであることがある。人物側（`characterStore.ts` の `samePath`）と
 * 同じ判定を使う。
 */
function isSamePath(left: string, right: string): boolean {
  return normalizePathForComparison(left) === normalizePathForComparison(right);
}
