import * as vscode from "vscode";
import * as path from "./paths";
import { fromUri } from "./paths";
import type { WorkEntry } from "../models/types";
import {
  assertUniqueStarts,
  CHAPTERS_FILE,
  CHAPTERS_SCHEMA_VERSION,
  emptyChapterSet,
  parseChapterSet,
  type ChapterSet,
} from "../models/chapter";
import { readWorkConfig, workPaths } from "./workRegistry";
import { hashBytes } from "./textFile";
import { atomicWriteFile } from "./atomicWrite";

/**
 * 章の台帳（`設定/章立て.json`）の読み書き（設計書6.66.1）。
 *
 * **作者が手で開いて直すJSONであり、別の端末からも同期で降ってくる。**
 * 一覧を出したまま外で直されたとき、こちらが覚えている古い値で上書きすると、
 * 作者が付けた章名が黙って消える。人物（`characterStore`）・設定資料
 * （`settingsStore`）・本の設計図（`bookStore`）と同じ約束をここでも守る。
 *
 *   - 読み込み時のハッシュを覚え、保存の直前に照合する。食い違えば止める
 *   - 壊れたJSONは修復しない。読めないと言って止まる
 *   - エディタに未保存の変更があれば書き込まない
 *
 * **原稿ファイルには一切書き込まない。** 章は台帳の中だけの情報で、
 * 本文へ見出し行を挿し込むようなことはしない（作者の原稿を触らない）。
 *
 * ## 退避（`.novelai-recovery`）は無い
 *
 * 書き込みは `atomicWriteFile` の**指定なし**（一時ファイル→置き換え）で
 * ある。世代退避を持たない代わりに、**照合で外部変更をはじく**のと、
 * `設定/` がGit管理下で「復元」から戻せることに頼る
 * （CLAUDE.mdの実装ルール2、`SettingsStore`・`BookStore` と同じ形）。
 */

export type ChapterStoreErrorKind =
  | "modified_externally"
  | "invalid_json"
  | "duplicate_start"
  | "unsaved_changes"
  | "not_loaded";

export class ChapterStoreError extends Error {
  constructor(
    message: string,
    readonly kind: ChapterStoreErrorKind,
    /** 作者に見せる場所。通知から開けるようにするために持つ */
    readonly filePath?: string
  ) {
    super(message);
    this.name = "ChapterStoreError";
  }
}

export class ChapterStore {
  private target: string | null = null;
  /**
   * 読み込んだときの中身のハッシュ。
   *
   * **ファイルが無かったときは null。** 「無かった」と「読んでいない」を
   * 分けないと、外で作られた台帳に気づかず上書きしてしまう。
   */
  private snapshot: string | null = null;
  private loaded = false;

  constructor(private readonly work: WorkEntry) {}

  /** 台帳の場所。作品設定で `設定/` の名前を変えている場合にも従う */
  async filePath(): Promise<string> {
    if (!this.target) {
      const config = await readWorkConfig(this.work);
      this.target = path.join(
        workPaths(this.work, config).settings,
        CHAPTERS_FILE
      );
    }
    return this.target;
  }

  /**
   * 台帳を読む。**無ければ「章が1つも無い」として返す**（作らない）。
   *
   * 壊れていたら `invalid_json` で止める。このとき読み込み済みにしないので、
   * 続けて保存しようとしても弾かれる——**読めなかったものを、こちらの
   * 手持ちで塗り替えない**ためである。
   */
  async load(): Promise<ChapterSet> {
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
      return emptyChapterSet();
    }

    let set: ChapterSet;
    try {
      set = parseChapterSet(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ChapterStoreError(
        `設定/${CHAPTERS_FILE} を読めませんでした。${detail}` +
          "　直してからもう一度お試しください（こちらでは書き換えません）。",
        "invalid_json",
        target
      );
    }

    this.snapshot = hashBytes(bytes);
    this.loaded = true;
    return set;
  }

  /** 台帳を書く。**読み込み後に外で変わっていたら書かない** */
  async save(set: ChapterSet): Promise<void> {
    if (!this.loaded) {
      throw new ChapterStoreError(
        "章立てを読み込めていないため保存しませんでした。一覧を開き直してください。",
        "not_loaded",
        this.target ?? undefined
      );
    }

    // 画面の側の不具合で重複が入り込んでも、台帳には残さない
    // （読み込みでは弾いているので、ここは書く側の最後の関所）
    try {
      assertUniqueStarts(set.chapters);
    } catch (error) {
      throw new ChapterStoreError(
        `章立てを保存できませんでした。${
          error instanceof Error ? error.message : String(error)
        }`,
        "duplicate_start",
        this.target ?? undefined
      );
    }

    const target = await this.filePath();
    await this.assertSaveAllowed(target);

    const body = JSON.stringify(
      { schemaVersion: set.schemaVersion || CHAPTERS_SCHEMA_VERSION, chapters: set.chapters },
      null,
      2
    );
    const bytes = new TextEncoder().encode(`${body}\n`);
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    await atomicWriteFile(target, bytes);
    this.snapshot = hashBytes(bytes);
  }

  /**
   * 保存してよいかを確かめる。手本は `BookStore.assertSaveAllowed`。
   *
   * 「読み込み時と同じ中身がそこにある」ことだけを許す。
   * 消えていた・作られていた・書き換わっていた、のどれも止める。
   */
  private async assertSaveAllowed(target: string): Promise<void> {
    if (this.dirtyDocumentPath(target)) {
      throw new ChapterStoreError(
        `エディタで開いている ${CHAPTERS_FILE} に未保存の変更があるため保存しませんでした。` +
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
      throw new ChapterStoreError(
        externalChangeMessage("読み込んだあとに削除されました"),
        "modified_externally",
        target
      );
    }

    if (this.snapshot === null) {
      throw new ChapterStoreError(
        externalChangeMessage("一覧を開いたあとに作られました"),
        "modified_externally",
        target
      );
    }

    if (hashBytes(current) !== this.snapshot) {
      throw new ChapterStoreError(
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
    `章の台帳（${CHAPTERS_FILE}）が${reason}。` +
    "こちらの内容で上書きしないよう保存を中止しました。" +
    "作品一覧を更新してからやり直してください。"
  );
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError && error.code === "FileNotFound"
  );
}
