import * as vscode from "vscode";
import * as path from "./paths";
import { fromUri } from "./paths";
import type { WorkEntry } from "../models/types";
import {
  assertReaderStatsRecords,
  assertUniqueSiteProfiles,
  assertUniqueSites,
  emptyPostingLedger,
  parsePostingLedger,
  POSTING_FILE,
  POSTING_SCHEMA_VERSION,
  type PostingLedger,
} from "../models/posting";
import { readWorkConfig, workPaths } from "./workRegistry";
import { hashBytes } from "./textFile";
import { atomicWriteFile } from "./atomicWrite";

/**
 * 投稿状態の台帳（`設定/投稿状態.json`）の読み書き（設計書6.68.2）。
 *
 * **`設定/` に置くのでGitで同期される。** 「PCで書いてスマホから投稿する」
 * のがこの機能の狙いなので、**開いたまま別の端末で書かれること**が
 * 現実に起きる。こちらが覚えている古い中身で上書きすると、向こうで
 * 付けた「投稿済み」が黙って消え、同じ話をもう一度出すことになる。
 * 章立て（`chapterStore`）・本の設計図（`bookStore`）と同じ約束を守る。
 *
 *   - 読み込み時のハッシュを覚え、保存の直前に照合する。食い違えば止める
 *   - 壊れたJSONは修復しない。読めないと言って止まる
 *   - エディタに未保存の変更があれば書き込まない
 *
 * **原稿にも投稿サイトにも触らない。** ここが書くのは台帳1つだけである。
 *
 * ## 退避（`.novelai-recovery`）は無い
 *
 * 書き込みは `atomicWriteFile` の**指定なし**（一時ファイル→置き換え）。
 * 世代退避を持たない代わりに、**照合で外部変更をはじく**のと、`設定/` が
 * Git管理下で「復元」から戻せることに頼る（CLAUDE.mdの実装ルール2）。
 */

export type PostingStoreErrorKind =
  | "modified_externally"
  | "invalid_json"
  | "duplicate_site"
  /** 読者の反応の記録が、記録として読めない（設計書6.79.7） */
  | "invalid_record"
  | "unsaved_changes"
  | "not_loaded";

export class PostingStoreError extends Error {
  constructor(
    message: string,
    readonly kind: PostingStoreErrorKind,
    /** 作者に見せる場所。通知から開けるようにするために持つ */
    readonly filePath?: string
  ) {
    super(message);
    this.name = "PostingStoreError";
  }
}

export class PostingStore {
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
        POSTING_FILE
      );
    }
    return this.target;
  }

  /**
   * 台帳を読む。**無ければ「記録が1つも無い」として返す**（作らない）。
   *
   * 壊れていたら `invalid_json` で止める。このとき読み込み済みにしないので、
   * 続けて保存しようとしても弾かれる——**読めなかったものを、こちらの
   * 手持ちで塗り替えない**ためである。
   */
  async load(): Promise<PostingLedger> {
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
      return emptyPostingLedger();
    }

    let ledger: PostingLedger;
    try {
      ledger = parsePostingLedger(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PostingStoreError(
        `設定/${POSTING_FILE} を読めませんでした。${detail}` +
          "　直してからもう一度お試しください（こちらでは書き換えません）。",
        "invalid_json",
        target
      );
    }

    this.snapshot = hashBytes(bytes);
    this.loaded = true;
    return ledger;
  }

  /** 台帳を書く。**読み込み後に外で変わっていたら書かない** */
  async save(ledger: PostingLedger): Promise<void> {
    if (!this.loaded) {
      throw new PostingStoreError(
        "投稿状態を読み込めていないため保存しませんでした。もう一度お試しください。",
        "not_loaded",
        this.target ?? undefined
      );
    }

    // 画面の側の不具合で重複が入り込んでも、台帳には残さない
    // （読み込みでは弾いているので、ここは書く側の最後の関所）
    try {
      assertUniqueSites(ledger.sites);
      // 作品情報も同じ関所を通す（片方だけ緩いと、そちらが抜け道になる）
      assertUniqueSiteProfiles(ledger.siteProfiles ?? []);
    } catch (error) {
      throw new PostingStoreError(
        `投稿状態を保存できませんでした。${
          error instanceof Error ? error.message : String(error)
        }`,
        "duplicate_site",
        this.target ?? undefined
      );
    }

    /*
      読者の反応（設計書6.79.7）も、**書く側の最後の関所を通す。**
      封筒（ブラウザ拡張）から来た値が混ざる経路なので、読み込みだけを
      厳しくしても足りない——中身の無い記録や負の数を台帳へ入れない。
    */
    try {
      assertReaderStatsRecords(ledger.readerStats ?? []);
    } catch (error) {
      throw new PostingStoreError(
        `投稿状態を保存できませんでした。${
          error instanceof Error ? error.message : String(error)
        }`,
        "invalid_record",
        this.target ?? undefined
      );
    }

    const target = await this.filePath();
    await this.assertSaveAllowed(target);

    const body = JSON.stringify(
      {
        schemaVersion: ledger.schemaVersion || POSTING_SCHEMA_VERSION,
        // **項目を並べて書き直さない**——並べると、欄が増えたときに
        // ここだけ古くなって作者が入れた値が保存で落ちる
        sites: ledger.sites,
        /*
          サイトごとの作品情報（6.68.5）。**書き出しは新形式だけ**で、
          旧形式（`sites[].profile`）はもう書かない（読み込みで台帳直下へ
          持ち上げてある）。

          **1件も無ければ欄ごと書かない。** 空の入れ物を足すと、この機能を
          使っていない作品の台帳が、投稿1回ぶんの記録と一緒に膨らむ。
        */
        ...(ledger.siteProfiles?.length
          ? { siteProfiles: ledger.siteProfiles }
          : {}),
        posts: ledger.posts,
        rankings: ledger.rankings ?? [],
        /*
          読者の反応（6.79.7）。**1件も無ければ欄ごと書かない**——作品情報
          （`siteProfiles`）と同じで、使っていない作品の台帳を空の入れ物で
          膨らませない。
        */
        ...(ledger.readerStats?.length
          ? { readerStats: ledger.readerStats }
          : {}),
      },
      null,
      2
    );
    const bytes = new TextEncoder().encode(`${body}\n`);
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    await atomicWriteFile(target, bytes);
    this.snapshot = hashBytes(bytes);
  }

  /**
   * 保存してよいかを確かめる。手本は `ChapterStore.assertSaveAllowed`。
   *
   * 「読み込み時と同じ中身がそこにある」ことだけを許す。
   * 消えていた・作られていた・書き換わっていた、のどれも止める。
   */
  private async assertSaveAllowed(target: string): Promise<void> {
    if (this.dirtyDocumentPath(target)) {
      throw new PostingStoreError(
        `エディタで開いている ${POSTING_FILE} に未保存の変更があるため保存しませんでした。` +
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
      throw new PostingStoreError(
        externalChangeMessage("読み込んだあとに削除されました"),
        "modified_externally",
        target
      );
    }

    if (this.snapshot === null) {
      throw new PostingStoreError(
        externalChangeMessage("読み込んだあとに作られました"),
        "modified_externally",
        target
      );
    }

    if (hashBytes(current) !== this.snapshot) {
      throw new PostingStoreError(
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
    `投稿状態の台帳（${POSTING_FILE}）が${reason}。` +
    "こちらの内容で上書きしないよう保存を中止しました。" +
    "別の端末から投稿した記録が届いている可能性があります。" +
    "同期してから、もう一度お試しください。"
  );
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError && error.code === "FileNotFound"
  );
}
