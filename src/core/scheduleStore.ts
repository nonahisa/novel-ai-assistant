import * as vscode from "vscode";
import * as path from "./paths";
import { fromUri } from "./paths";
import type { WorkEntry } from "../models/types";
import {
  emptyScheduleFile,
  parseScheduleFile,
  SCHEDULE_FILE,
  SCHEDULE_SCHEMA_VERSION,
  type ScheduleFile,
} from "../models/schedule";
import { readWorkConfig, workPaths } from "./workRegistry";
import { hashBytes } from "./textFile";
import { atomicWriteFile } from "./atomicWrite";
import {
  detectJsonFileFormat,
  formatJsonForFile,
  NEW_JSON_FILE_FORMAT,
  type JsonFileFormat,
} from "./jsonFileFormat";

/**
 * スケジュール（`設定/スケジュール.json`）の読み書き（設計書6.111.8）。
 *
 * **`設定/` に置くので Git で同期される。** 2台の機器で開いたまま書くことが
 * 現実に起きる。こちらが覚えている古い中身で上書きすると、向こうで付けた
 * 「済み」が黙って消える。投稿状態の台帳（`postingStore.ts`）と同じ約束を守る。
 *
 *   - 読み込み時のハッシュを覚え、保存の直前に照合する。食い違えば止める
 *   - 壊れたJSONは修復しない。読めないと言って止まる（競合マーカーの入ったものも同じ）
 *   - エディタに未保存の変更があれば書き込まない
 *   - 改行は元のファイルに合わせる（0.81.1 の `jsonFileFormat`）
 *
 * **2台で両方が書き換えた場合の合わせ方は、既存の同期（5.5）に任せる。**
 * スケジュールだけの特別な合わせ方は作らない。
 *
 * ## 退避（`.novelai-recovery`）は無い
 *
 * 書き込みは `atomicWriteFile` の**指定なし**（一時ファイル→置き換え）。
 * 照合で外部変更をはじくのと、`設定/` が Git 管理下で「復元」から戻せることに頼る。
 */

export type ScheduleStoreErrorKind =
  | "modified_externally"
  | "invalid_json"
  | "unsaved_changes"
  | "not_loaded";

export class ScheduleStoreError extends Error {
  constructor(
    message: string,
    readonly kind: ScheduleStoreErrorKind,
    readonly filePath?: string
  ) {
    super(message);
    this.name = "ScheduleStoreError";
  }
}

export class ScheduleStore {
  private target: string | null = null;
  /** 読み込んだときの中身のハッシュ。**ファイルが無かったときは null** */
  private snapshot: string | null = null;
  private loaded = false;
  private format: JsonFileFormat = NEW_JSON_FILE_FORMAT;

  constructor(private readonly work: WorkEntry) {}

  /** ファイルの場所。作品設定で `設定/` の名前を変えている場合にも従う */
  async filePath(): Promise<string> {
    if (!this.target) {
      const config = await readWorkConfig(this.work);
      this.target = path.join(workPaths(this.work, config).settings, SCHEDULE_FILE);
    }
    return this.target;
  }

  /** 無ければ空として返す（作らない）。壊れていたら `invalid_json` で止める */
  async load(): Promise<ScheduleFile> {
    const target = await this.filePath();
    this.loaded = false;
    this.snapshot = null;
    this.format = NEW_JSON_FILE_FORMAT;

    let bytes: Uint8Array | null = null;
    try {
      bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    if (!bytes) {
      this.loaded = true;
      return emptyScheduleFile();
    }

    let file: ScheduleFile;
    try {
      file = parseScheduleFile(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ScheduleStoreError(
        `設定/${SCHEDULE_FILE} を読めませんでした。${detail}` +
          "　直してからもう一度開いてください（こちらでは書き換えません。" +
          "同期の競合なら「競合を解消する」で直せます）。",
        "invalid_json",
        target
      );
    }
    this.snapshot = hashBytes(bytes);
    this.format = detectJsonFileFormat(bytes);
    this.loaded = true;
    return file;
  }

  /** 書く。**読み込み後に外で変わっていたら書かない** */
  async save(file: ScheduleFile): Promise<void> {
    if (!this.loaded) {
      throw new ScheduleStoreError(
        "スケジュールを読み込めていないため保存しませんでした。もう一度お試しください。",
        "not_loaded",
        this.target ?? undefined
      );
    }
    // 書く前に形を確かめる（画面の側の不具合で壊れた形を書かない）
    parseScheduleFile(JSON.parse(JSON.stringify(file)));

    const target = await this.filePath();
    await this.assertSaveAllowed(target);

    const body = formatJsonForFile(
      { schemaVersion: file.schemaVersion || SCHEDULE_SCHEMA_VERSION, schedules: file.schedules },
      this.format
    );
    const bytes = new TextEncoder().encode(body);
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    await atomicWriteFile(target, bytes);
    this.snapshot = hashBytes(bytes);
  }

  /** 「読み込み時と同じ中身がそこにある」ことだけを許す（`PostingStore` と同じ） */
  private async assertSaveAllowed(target: string): Promise<void> {
    if (this.dirtyDocumentPath(target)) {
      throw new ScheduleStoreError(
        `エディタで開いている ${SCHEDULE_FILE} に未保存の変更があるため保存しませんでした。` +
          "先にそちらを保存するか閉じてください。",
        "unsaved_changes",
        target
      );
    }
    let current: Uint8Array | null = null;
    try {
      current = await vscode.workspace.fs.readFile(path.toUri(target));
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    if (!current) {
      if (this.snapshot === null) return;
      throw new ScheduleStoreError(externalChangeMessage("読み込んだあとに削除されました"), "modified_externally", target);
    }
    if (this.snapshot === null) {
      throw new ScheduleStoreError(externalChangeMessage("読み込んだあとに作られました"), "modified_externally", target);
    }
    if (hashBytes(current) !== this.snapshot) {
      throw new ScheduleStoreError(externalChangeMessage("外部で変更されています"), "modified_externally", target);
    }
  }

  private dirtyDocumentPath(target: string): string | undefined {
    const wanted = path.normalizeForComparison(target);
    return vscode.workspace.textDocuments
      .filter((document) => document.isDirty)
      .map((document) => fromUri(document.uri))
      .find((filePath) => path.normalizeForComparison(filePath) === wanted);
  }
}

/**
 * 外部変更で止めたときの言い方。**「別の機器から」と決め打ちしない**
 * （同期・手での編集など、書き換える道は複数ある。`postingStore.ts` と同じ）。
 */
function externalChangeMessage(reason: string): string {
  return (
    `スケジュール（${SCHEDULE_FILE}）が${reason}。` +
    "こちらの内容で上書きしないよう保存を中止しました。" +
    "ほかの操作（同期・手での編集など）が先に書き換えています。" +
    "もう一度お試しください（読み直してから保存します）。"
  );
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}
