/** 登録された作品 */
export interface WorkEntry {
  /** 作品の一意ID */
  id: string;
  /** 表示名（既定はフォルダ名） */
  title: string;
  /** 作品フォルダの絶対パス */
  folderPath: string;
  /** 登録日時 (ISO8601) */
  registeredAt: string;
}

/** 本文ファイル1件の情報 */
export interface EpisodeFile {
  /** 絶対パス */
  filePath: string;
  /** ファイル名（拡張子含む） */
  fileName: string;
  /** 拡張子 (".txt" | ".md") */
  ext: string;
  /** 開始話数。判定できない場合 null */
  chapterStart: number | null;
  /** 終了話数。単話なら chapterStart と同じ */
  chapterEnd: number | null;
  /** ファイル名から抽出したサブタイトル。無い場合 null */
  subtitle: string | null;
  /** 種別 */
  kind: EpisodeKind;
  /** ファイル名が初期状態（数字のみ）か */
  isInitialName: boolean;
  /**
   * 日付で名付けられたファイルの投稿日（`YYYY-MM-DD`）。無ければ null。
   * SNS記事は投稿日で管理する（設計書6.4.6）
   */
  date?: string | null;
  /** 同じ日の中での並び（`2026-08-16_2` の 2）。1日に何本でも書ける */
  dateSeq?: number | null;
  /** 文字数（メタデータヘッダーがある場合は本文のみ） */
  counts: CharCounts;
  /** 投稿サイト由来のメタデータヘッダーを持つか */
  hasMetadata: boolean;
  /** メタデータ内の【タイトル】。話のサブタイトルとして使える */
  metaTitle: string | null;
  /** メタデータ内の【文字数】記載値（照合用） */
  declaredCharCount: number | null;
  /** メタデータ内の【更新日時】 */
  metaUpdatedAt: string | null;
  /**
   * Gitの未解決な競合マーカーを含むか。
   *
   * 含むファイルは文字数計測の対象外にする。マーカーと両方の版が
   * 混ざったまま数えると、実際より多い字数を本当の進捗として見せてしまう。
   */
  hasConflictMarkers: boolean;
  /**
   * 1ファイルに全話が入っている（合本）場合の話数。
   *
   * 小説家になろうのダウンロードは、全話を1ファイルにまとめた形を出す。
   * 1話ずつのファイルと区別が付かないと、219話ぶんを1話として扱ってしまう。
   * 合本でなければ null。
   */
  collectedCount: number | null;
  /**
   * この話に残っているシーンメモの短い印（設計書6.40.5）。
   *
   * 「TODO 3」のように、いちばん多いタグと件数を出す。
   * **無ければ空文字**（無いものの印は出さない）。
   *
   * 省略できるようにしてあるのは、走査を通らずに組み立てた
   * `EpisodeFile`（試験の材料）が壊れないようにするためである。
   */
  memoBadge?: string;
}

export type EpisodeKind = "本編" | "プロローグ" | "エピローグ" | "幕間" | "不明";

/** 文字数の計測結果 */
export interface CharCounts {
  /** 総文字数（改行を除く。空白は含む） */
  gross: number;
  /** 純文字数（改行・空白をすべて除く） */
  net: number;
  /** 行数（空行を含む） */
  lines: number;
  /** 段落数（空行で区切られたブロック数） */
  paragraphs: number;
  /**
   * 原稿用紙に書いたときに占める行数。
   *
   * 文字数を400で割っても原稿用紙の枚数にはならない。
   * 1行20字で折り返し、段落の最終行に余白が残るため、
   * 実際の枚数は割り算の結果よりかなり多くなる。
   * 集計時に合算できるよう、枚数ではなく行数で持つ。
   */
  manuscriptLines: number;
}

/** 作品単位の集計 */
export interface WorkStats {
  fileCount: number;
  totals: CharCounts;
  /** 未解決の競合を含むため、集計から除いたファイル数 */
  conflictedCount: number;
}

/** .aiwriter/config.json の内容（フェーズ0で使う範囲） */
export interface WorkConfig {
  schemaVersion: string;
  workTitle: string;
  /** 本文フォルダの相対パス（既定 "本文"） */
  manuscriptDir: string;
  /** 設定フォルダの相対パス（既定 "設定"） */
  settingsDir: string;
  createdAt: string;
}

export const CONFIG_SCHEMA_VERSION = "0.1";
export const AIWRITER_DIR = ".aiwriter";
export const CONFIG_FILE = "config.json";
export const DEFAULT_MANUSCRIPT_DIR = "本文";
export const DEFAULT_SETTINGS_DIR = "設定";
export const SUPPORTED_EXTENSIONS = [".txt", ".md"] as const;
