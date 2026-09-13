import * as vscode from "vscode";
import * as path from "./paths";
import { fromUri } from "./paths";
import type { WorkEntry } from "../models/types";
import {
  emptyReaderProfile,
  READER_PROFILE_FILE,
  READER_PROFILE_SCHEMA_VERSION,
  type ReaderAxis,
  type ReaderEvidence,
  type ReaderProfile,
  type ReaderScores,
} from "../models/readerProfile";
import { READER_AXIS_ORDER, READER_QUESTIONS } from "./readerTarget";
import { readWorkConfig, workPaths } from "./workRegistry";
import { hashBytes } from "./textFile";
import { atomicWriteFile } from "./atomicWrite";

/**
 * ターゲット読者の台帳（`設定/読者像.json`）の読み書き（設計書6.91）。
 *
 * **作者が手で開いて直すJSONであり、別の端末からも同期で降ってくる。**
 * 章立て（`chapterStore`）・人物（`characterStore`）と同じ約束を守る。
 *
 *   - 読み込み時のハッシュを覚え、保存の直前に照合する。食い違えば止める
 *   - 壊れたJSONは修復しない。読めないと言って止まる
 *   - エディタに未保存の変更があれば書き込まない
 *
 * **原稿には一切書き込まない。** 読者像は台帳の中だけの情報である。
 *
 * ## 退避（`.novelai-recovery`）は無い
 *
 * `atomicWriteFile` の**指定なし**（一時ファイル→置き換え）で書く。
 * 世代退避を持たない代わりに、照合で外部変更をはじくのと、
 * `設定/` がGit管理下で「復元」から戻せることに頼る
 * （CLAUDE.mdの実装ルール2、`ChapterStore`・`SettingsStore` と同じ形）。
 */

export type ReaderTargetStoreErrorKind =
  | "modified_externally"
  | "invalid_json"
  | "unsaved_changes"
  | "not_loaded";

export class ReaderTargetStoreError extends Error {
  constructor(
    message: string,
    readonly kind: ReaderTargetStoreErrorKind,
    readonly filePath?: string
  ) {
    super(message);
    this.name = "ReaderTargetStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 点数を読み解く。
 *
 * **0〜6の外は受け取らない。** 作者が手で直すファイルであり、AIが書いた
 * 値も通る。範囲の外が入ると段階の判定が壊れ、どのタイプにも当てはまらない
 * 結果が出る（CLAUDE.mdの実装ルール3「AIの出力を信用しない」）。
 */
export function parseReaderScores(raw: unknown): ReaderScores {
  if (!isRecord(raw)) throw new Error("点数の形が違います。");
  const scores = {} as ReaderScores;
  for (const axis of READER_AXIS_ORDER) {
    const value = raw[axis];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`点数「${axis}」が数ではありません。`);
    }
    if (value < 0 || value > 6) {
      throw new Error(`点数「${axis}」が0〜6の外です（${value}）。`);
    }
    scores[axis] = value;
  }
  return scores;
}

function parseAnswers(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new Error("答えの形が違います。");
  return raw.map((value, index) => {
    const question = READER_QUESTIONS[index];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      !question ||
      value < 0 ||
      value >= question.choices.length
    ) {
      throw new Error(`${index + 1}問目の答えが選択肢の外です。`);
    }
    return value;
  });
}

/**
 * 根拠を読み解く。
 *
 * **読めない1件で全体を落とさない。** 根拠は説明のための添え物であって、
 * 判定は点数のほうで決まっている。1件が壊れていることを理由に
 * 台帳ごと読めなくすると、作者は診断そのものを失う。
 */
function parseEvidence(raw: unknown): ReaderEvidence[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("根拠の形が違います。");
  const axes = new Set<string>(READER_AXIS_ORDER);
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { axis, quote, from } = entry;
    if (typeof axis !== "string" || !axes.has(axis)) return [];
    if (typeof quote !== "string" || !quote.trim()) return [];
    return [
      {
        axis: axis as ReaderAxis,
        quote,
        from: typeof from === "string" ? from : "",
      },
    ];
  });
}

function parseTime(raw: unknown, what: string): string {
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    throw new Error(`${what}の日時が読めません。`);
  }
  return raw;
}

/**
 * 台帳を読み解く。
 *
 * **壊れていたら直さずに投げる**（CLAUDE.mdの実装ルール2）。
 * 作者が手で書き換えるファイルなので、こちらの解釈で上書きしない。
 */
export function parseReaderProfile(raw: unknown): ReaderProfile {
  if (!isRecord(raw)) throw new Error("読者像の台帳の形が違います。");

  const profile: ReaderProfile = {
    schemaVersion:
      typeof raw.schemaVersion === "string" && raw.schemaVersion
        ? raw.schemaVersion
        : READER_PROFILE_SCHEMA_VERSION,
  };

  if (raw.declared !== undefined && raw.declared !== null) {
    if (!isRecord(raw.declared)) throw new Error("宣言の形が違います。");
    profile.declared = {
      scores: parseReaderScores(raw.declared.scores),
      answers: parseAnswers(raw.declared.answers),
      updatedAt: parseTime(raw.declared.updatedAt, "宣言"),
    };
  }

  if (raw.actual !== undefined && raw.actual !== null) {
    if (!isRecord(raw.actual)) throw new Error("実像の形が違います。");
    profile.actual = {
      scores: parseReaderScores(raw.actual.scores),
      evidence: parseEvidence(raw.actual.evidence),
      basis: typeof raw.actual.basis === "string" ? raw.actual.basis : "",
      model: typeof raw.actual.model === "string" ? raw.actual.model : "",
      updatedAt: parseTime(raw.actual.updatedAt, "実像"),
    };
  }

  return profile;
}

export class ReaderTargetStore {
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
        READER_PROFILE_FILE
      );
    }
    return this.target;
  }

  /** 台帳を読む。**無ければ「まだ答えていない」として返す**（作らない） */
  async load(): Promise<ReaderProfile> {
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
      return emptyReaderProfile();
    }

    let profile: ReaderProfile;
    try {
      profile = parseReaderProfile(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReaderTargetStoreError(
        `設定/${READER_PROFILE_FILE} を読めませんでした。${detail}` +
          "　直してからもう一度お試しください（こちらでは書き換えません）。",
        "invalid_json",
        target
      );
    }

    this.snapshot = hashBytes(bytes);
    this.loaded = true;
    return profile;
  }

  /** 台帳を書く。**読み込み後に外で変わっていたら書かない** */
  async save(profile: ReaderProfile): Promise<void> {
    if (!this.loaded) {
      throw new ReaderTargetStoreError(
        "読者像を読み込めていないため保存しませんでした。開き直してください。",
        "not_loaded",
        this.target ?? undefined
      );
    }

    const target = await this.filePath();
    await this.assertSaveAllowed(target);

    const body = JSON.stringify(
      {
        schemaVersion: profile.schemaVersion || READER_PROFILE_SCHEMA_VERSION,
        declared: profile.declared,
        actual: profile.actual,
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
    const dirty = this.dirtyDocumentPath(target);
    if (dirty) {
      throw new ReaderTargetStoreError(
        `エディタで開いている ${READER_PROFILE_FILE} に未保存の変更があるため保存しませんでした。` +
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
      throw new ReaderTargetStoreError(
        externalChangeMessage("読み込んだあとに削除されました"),
        "modified_externally",
        target
      );
    }

    if (this.snapshot === null) {
      throw new ReaderTargetStoreError(
        externalChangeMessage("開いたあとに作られました"),
        "modified_externally",
        target
      );
    }

    if (hashBytes(current) !== this.snapshot) {
      throw new ReaderTargetStoreError(
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
    `設定/${READER_PROFILE_FILE} が${reason}。上書きを避けるため保存しませんでした。` +
    "　開き直してから、もう一度お試しください。"
  );
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError && error.code === "FileNotFound"
  );
}
