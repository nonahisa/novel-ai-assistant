import * as vscode from "vscode";
import * as path from "./paths";
import { fromUri } from "./paths";
import type { WorkEntry } from "../models/types";
import {
  BOOK_DIR,
  BOOK_FILE,
  defaultBookConfig,
  parseBookConfig,
  type BookConfig,
} from "../models/book";
import { readWorkConfig, workPaths } from "./workRegistry";
import { hashBytes } from "./textFile";
import { atomicWriteFile } from "./atomicWrite";

/**
 * 本の設計図（`設定/書籍/book.json`）の読み書き（設計書6.65.6）。
 *
 * **作者が手で開いて直すJSONであり、別の端末からも同期で降ってくる。**
 * エディター画面を開いたまま外で直されたとき、画面の中の古い値で
 * 上書きすると、作者が書いたものが黙って消える。人物（`characterStore`）・
 * 設定資料（`settingsStore`）と同じ約束をここでも守る。
 *
 *   - 読み込み時のハッシュを覚え、保存の直前に照合する。食い違えば止める
 *   - 壊れたJSONは修復しない。読めないと言って止まる
 *   - エディタに未保存の変更があれば書き込まない
 *
 * ## 退避（`.novelai-recovery`）は無い
 *
 * 書き込みは `atomicWriteFile` の**指定なし**（一時ファイル→置き換え）で
 * ある。人物のような世代退避は持たない代わりに、**照合で外部変更を
 * はじく**のと、`設定/` がGit管理下で「復元」から戻せることに頼る
 * （CLAUDE.mdの実装ルール2、`SettingsStore` と同じ形）。
 */

export type BookStoreErrorKind =
  | "modified_externally"
  | "invalid_json"
  | "unsaved_changes"
  | "not_loaded";

export class BookStoreError extends Error {
  constructor(
    message: string,
    readonly kind: BookStoreErrorKind,
    /** 作者に見せる場所。通知から開けるようにするために持つ */
    readonly filePath?: string
  ) {
    super(message);
    this.name = "BookStoreError";
  }
}

export class BookStore {
  private target: string | null = null;
  /**
   * 読み込んだときの中身のハッシュ。
   *
   * **ファイルが無かったときは null。** 「無かった」と「読んでいない」を
   * 分けないと、外で作られた設計図に気づかず上書きしてしまう。
   */
  private snapshot: string | null = null;
  private loaded = false;

  constructor(private readonly work: WorkEntry) {}

  /** 設計図の場所。作品設定で `設定/` の名前を変えている場合にも従う */
  async filePath(): Promise<string> {
    if (!this.target) {
      const config = await readWorkConfig(this.work);
      this.target = path.join(
        workPaths(this.work, config).settings,
        BOOK_DIR,
        BOOK_FILE
      );
    }
    return this.target;
  }

  /**
   * 設計図を読む。**無ければ作品名から既定値**（書き出しと同じ扱い）。
   *
   * 壊れていたら `invalid_json` で止める。このとき読み込み済みにしないので、
   * 続けて保存しようとしても弾かれる——**読めなかったものを画面の値で
   * 塗り替えない**ためである。
   */
  async load(): Promise<BookConfig> {
    const target = await this.filePath();
    this.loaded = false;
    this.snapshot = null;

    let bytes: Uint8Array | null = null;
    try {
      bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }

    if (!bytes) {
      this.loaded = true;
      return defaultBookConfig(this.work.title);
    }

    let config: BookConfig;
    try {
      config = parseBookConfig(
        JSON.parse(new TextDecoder().decode(bytes)),
        this.work.title
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BookStoreError(
        `設定/${BOOK_DIR}/${BOOK_FILE} を読めませんでした。${detail}` +
          "　直してからもう一度お試しください（こちらでは書き換えません）。",
        "invalid_json",
        target
      );
    }

    this.snapshot = hashBytes(bytes);
    this.loaded = true;
    return config;
  }

  /** 設計図を書く。**読み込み後に外で変わっていたら書かない** */
  async save(config: BookConfig): Promise<void> {
    if (!this.loaded) {
      throw new BookStoreError(
        "本の設計図を読み込めていないため保存しませんでした。画面を開き直してください。",
        "not_loaded",
        this.target ?? undefined
      );
    }

    const target = await this.filePath();
    await this.assertSaveAllowed(target);

    const bytes = new TextEncoder().encode(
      `${JSON.stringify(config, null, 2)}\n`
    );
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    await atomicWriteFile(target, bytes);
    this.snapshot = hashBytes(bytes);
  }

  /**
   * 保存してよいかを確かめる。手本は `SettingsStore.assertSaveAllowed`。
   *
   * 「読み込み時と同じ中身がそこにある」ことだけを許す。
   * 消えていた・作られていた・書き換わっていた、のどれも止める。
   */
  private async assertSaveAllowed(target: string): Promise<void> {
    const unsaved = this.dirtyDocumentPath(target);
    if (unsaved) {
      throw new BookStoreError(
        "エディタで開いている book.json に未保存の変更があるため保存しませんでした。" +
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
      // 読み込んだときも無かったのなら、これが最初の1つになる
      if (this.snapshot === null) return;
      throw new BookStoreError(
        externalChangeMessage("読み込んだあとに削除されました"),
        "modified_externally",
        target
      );
    }

    if (this.snapshot === null) {
      throw new BookStoreError(
        externalChangeMessage("画面を開いたあとに作られました"),
        "modified_externally",
        target
      );
    }

    if (hashBytes(current) !== this.snapshot) {
      throw new BookStoreError(
        externalChangeMessage("外部で変更されています"),
        "modified_externally",
        target
      );
    }
  }

  /**
   * 同じファイルが未保存のまま開かれていないか。
   *
   * Windowsは大文字小文字を区別しないので、文字列の一致では見分けられない
   * （`settingsStore.ts` の `isSamePath` と同じ判定）。
   */
  private dirtyDocumentPath(target: string): string | undefined {
    const wanted = path.normalizeForComparison(target);
    return vscode.workspace.textDocuments
      .filter((document) => document.isDirty)
      .map((document) => fromUri(document.uri))
      .find((filePath) => path.normalizeForComparison(filePath) === wanted);
  }
}

/** 外部変更で止めたときの言い方。作者が次に何をすればよいかまで書く */
function externalChangeMessage(reason: string): string {
  return (
    `本の設計図（${BOOK_DIR}/${BOOK_FILE}）が${reason}。` +
    "画面の内容で上書きしないよう保存を中止しました。" +
    "パネルを開き直してください。"
  );
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError && error.code === "FileNotFound"
  );
}
