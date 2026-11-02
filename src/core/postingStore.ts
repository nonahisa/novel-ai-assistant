import * as vscode from "vscode";
import { isFileNotFound } from "./fsErrors";
import * as path from "./paths";
import { fromUri } from "./paths";
import type { WorkEntry } from "../models/types";
import {
  assertReaderStatsRecords,
  assertUniqueSiteProfiles,
  assertUniqueSites,
  emptyPostingLedger,
  readPostingLedger,
  POSTING_FILE,
  POSTING_SCHEMA_VERSION,
  type PostingLedger,
  type PostingSiteFacts,
  type SkippedSiteCompletion,
} from "../models/posting";
import { readWorkConfig, workPaths } from "./workRegistry";
import { hashBytes } from "./textFile";
import { atomicWriteFile } from "./atomicWrite";
import { logStep } from "./logger";

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
    readonly filePath?: string,
    /**
     * 台帳を読み込んだ時刻（ISO。外部変更で止めたときだけ持つ。0.81.4）。
     * **どれだけ開いたまま待っていたか**を、ログから追えるようにする——
     * 実機では、2択を開いている間に別の取り込みが書いていた
     */
    readonly loadedAt?: string
  ) {
    super(message);
    this.name = "PostingStoreError";
  }
}

/**
 * 台帳を保存し終えたときの知らせの口（作者の指示 2026-11-02「ランキングに入ったり順位が
 * 上がった場合、風船とか花火を」）。**順位はいくつもの道から入る**（手の記録・ヘルパーの
 * 取り込み・なろう殿堂入りAPI）ので、道ごとにお祝いを呼ぶのでなく、台帳を書いた所1か所で
 * 知らせる。**core からは通知を出さない**ので、知らせ方は拡張機能の起動時に付ける
 * （`features/rankCelebrations.ts`）。聞き手の失敗で保存を失敗にしない。
 */
let savedListener: ((work: WorkEntry, ledger: PostingLedger) => void) | undefined;

export function onPostingSaved(
  listener: (work: WorkEntry, ledger: PostingLedger) => void
): { dispose(): void } {
  savedListener = listener;
  return {
    dispose: () => {
      if (savedListener === listener) savedListener = undefined;
    },
  };
}

/** 知らない値を読まなかった台帳の知らせ（作者の判断 2026-11-01） */
export interface PostingUnknownValues {
  /** 台帳の場所 */
  readonly filePath: string;
  /** 読まなかった値の説明（「作品の連載の状態「…」」） */
  readonly notes: readonly string[];
}

let unknownValuesListener: ((info: PostingUnknownValues) => void) | undefined;

/**
 * 知らない値を読まなかったときの知らせの口（1つだけ。あとから付けた方に替わる）。
 *
 * **core からは通知を出さない**ので、知らせ方（作者に一度だけ言う）は拡張機能の
 * 起動時に付ける（`features/postingKit.ts` の `notifyPostingUnknownValuesOnce`）。
 * 台帳を開く道は投稿キット・執筆統計・作品一覧と多く、そのどこから読んでも同じ所で知らせる。
 */
export function onPostingUnknownValues(
  listener: (info: PostingUnknownValues) => void
): { dispose(): void } {
  unknownValuesListener = listener;
  return {
    dispose: () => {
      if (unknownValuesListener === listener) unknownValuesListener = undefined;
    },
  };
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
  /** 読み込んだ時刻。外部変更で止めたときにログへ残す（0.81.4） */
  private loadedAt: string | undefined;
  /**
   * 読み込みで読み飛ばした、読者の反応の行（JSONそのままの形。0.33.9）。
   *
   * **保存でそのまま書き戻す。** 読めなかったからといって落とすと、
   * 新しい版の機械が書いた行を、こちらが黙って消すことになる
   * （同期で降ってきた「投稿済み」を上書きしないのと同じ理由）。
   * 検証はしない——読めないものを整えれば、整えた形がこちらの作り物になる。
   */
  private skippedReaderStatsRows: unknown[] = [];
  /**
   * 読み込みで読まなかった、この版が知らない連載の状態（作者の判断 2026-11-01）。
   * **保存で書き戻す**（読み飛ばした行と同じ理由）。ただし作者が選び直した・新しい封筒が
   * 知っている値を入れたときは、そちらが勝つ（そのときは書き戻さない）
   */
  private skippedCompletion: Record<string, unknown> | undefined;
  private skippedSiteCompletions: SkippedSiteCompletion[] = [];

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
    this.loadedAt = new Date().toISOString();
    // 前に読んだ台帳の行を、別の台帳へ持ち込まない
    this.skippedReaderStatsRows = [];
    this.skippedCompletion = undefined;
    this.skippedSiteCompletions = [];

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
    let unknownNotes: string[] = [];
    try {
      const read = readPostingLedger(
        JSON.parse(new TextDecoder().decode(bytes))
      );
      ledger = read.ledger;
      /*
        **読み飛ばした行があれば、記録に残す**（設計書6.79.7、0.33.9）。
        知らない指標しか無い行は台帳を止めずに飛ばすが、黙って減らすと
        「記録したはずの行が無い」ことにしか気づけない。通知は出さない
        ——開くたびに同じ知らせが出ると、直すまで邪魔になる。
      */
      this.skippedReaderStatsRows = read.skippedReaderStatsRows;
      if (read.skippedReaderStats > 0) {
        logStep(
          `設定/${POSTING_FILE}: この版が知らない指標しか無い読者の反応を ` +
            `${read.skippedReaderStats}件 読み飛ばしました（保存時もそのまま持ち回します）`
        );
      }
      this.skippedCompletion = read.skippedCompletion;
      this.skippedSiteCompletions = read.skippedSiteCompletions;
      unknownNotes = read.unknownValues;
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
    /*
      **知らない値を読まなかったことを、知らせの口へ渡す**（2026-11-01）。知らせるのは
      画面の側（core から通知を出さない）。何度も同じ知らせが出ないようにするのも、あちら
    */
    if (unknownNotes.length > 0) {
      logStep(
        `設定/${POSTING_FILE}: この版が知らない値を読まずに持ち回します（${unknownNotes.join("、")}）`
      );
      unknownValuesListener?.({ filePath: target, notes: unknownNotes });
    }
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

    /*
      **読み飛ばした行を、末尾へ書き戻す**（0.33.9）。読めた行だけを
      書き戻すと、新しい版の機械が書いた行をこちらが消すことになる。

      並びは元の位置へ戻さず末尾でよい——**追記だけの配列**で、読む側は
      `readAt` で並べ直す（`readerStatsForSite`）。位置を覚えて戻すには
      読み飛ばした行の前後関係も持ち回ることになり、得るものが無い。
    */
    const readerStats: unknown[] = [
      ...(ledger.readerStats ?? []),
      ...this.skippedReaderStatsRows,
    ];

    /*
      サイトごとの事柄へ、読まなかった知らない連載の状態を戻す（2026-11-01）。
      **その間に封筒が知っている値を入れたサイトは戻さない**（新しい方が勝つ）。
      欄の並びは元の台帳と違うことがあるが、中身は同じ（読む側は欄の名前で読む）
    */
    const siteFacts: Array<PostingSiteFacts | Record<string, unknown>> = [
      ...(ledger.siteFacts ?? []),
    ];
    for (const skipped of this.skippedSiteCompletions) {
      const index = siteFacts.findIndex((entry) => entry.site === skipped.site);
      const restored = { completion: skipped.completion, completionAt: skipped.completionAt };
      if (index < 0) {
        siteFacts.push({ site: skipped.site, ...restored });
      } else if ((siteFacts[index] as PostingSiteFacts).completion === undefined) {
        siteFacts[index] = { ...siteFacts[index], ...restored };
      }
    }

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
        /*
          修正版の出し直し（6.68.7）。**名指しして書かないと、記録しても保存で消える。**
          1件も無ければ欄ごと書かない。この欄を知らない古い版が保存すると消える
          （`siteFacts` と同じ「消せない限界」）——消えても投稿の記録と未投稿の数は変わらない
        */
        ...(ledger.revisions?.length ? { revisions: ledger.revisions } : {}),
        rankings: ledger.rankings ?? [],
        /*
          読者の反応（6.79.7）。**1件も無ければ欄ごと書かない**——作品情報
          （`siteProfiles`）と同じで、使っていない作品の台帳を空の入れ物で
          膨らませない。読み飛ばした行だけがある台帳では、**その行だけを
          書く**（読めないからといって落とさない）。
        */
        ...(readerStats.length ? { readerStats } : {}),
        /*
          サイトごとの今のタグ・連載の状態、タグの付け替え、作品の連載の状態
          （作者の指示 2026-11-01）。**ここで名指しして書かないと、読めても保存で消える。**
          使っていない作品の台帳を膨らませないよう、無ければ欄ごと書かない。

          **この欄を知らない古い版が保存すると、3つとも消える**（古い版は名指しした欄しか
          書かない。サイト固有の指標と同じ「消せない限界」。設計書6.79.7）。
        */
        ...(siteFacts.length ? { siteFacts } : {}),
        ...(ledger.tagChanges?.length ? { tagChanges: ledger.tagChanges } : {}),
        /*
          作者の印。**作者が選んでいれば、そちらが勝つ**。選んでいなければ、読まなかった
          知らない値をそのまま戻す（新しい版が書いた値を消さない。2026-11-01）
        */
        ...(ledger.completion
          ? { completion: ledger.completion }
          : this.skippedCompletion
            ? { completion: this.skippedCompletion }
            : {}),
      },
      null,
      2
    );
    const bytes = new TextEncoder().encode(`${body}\n`);
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    await atomicWriteFile(target, bytes);
    this.snapshot = hashBytes(bytes);
    try {
      savedListener?.(this.work, ledger);
    } catch {
      // 知らせの側の失敗で、書けた保存を失敗にしない（聞き手が自分でログに残す）
    }
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
        target,
        this.loadedAt
      );
    }

    if (this.snapshot === null) {
      throw new PostingStoreError(
        externalChangeMessage("読み込んだあとに作られました"),
        "modified_externally",
        target,
        this.loadedAt
      );
    }

    if (hashBytes(current) !== this.snapshot) {
      throw new PostingStoreError(
        externalChangeMessage("外部で変更されています"),
        "modified_externally",
        target,
        this.loadedAt
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

/**
 * 外部変更で止めたときの言い方。作者が次に何をすればよいかまで書く。
 *
 * **「別の端末から」と決め打ちしない**（0.81.4）。実機で止まったときは、
 * 31秒前に**同じ機械**でヘルパーからの読者の反応の取り込みが書いていた。
 * 書き換える道は、同期・ヘルパーからの取り込み・手での編集と複数あり、
 * どれだったかはこちらには分からない——例を並べるだけにする。
 * やり直せば読み直してから保存するので、次の操作は「もう一度」でよい。
 */
function externalChangeMessage(reason: string): string {
  return (
    `投稿の記録（${POSTING_FILE}）が${reason}。` +
    "こちらの内容で上書きしないよう保存を中止しました。" +
    "ほかの操作（同期・ヘルパーからの取り込み・手での編集など）が先に書き換えています。" +
    "もう一度お試しください（読み直してから保存します）。"
  );
}
