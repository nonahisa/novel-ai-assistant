/**
 * 執筆量の記録（設計書6.3・5.5.6）。
 *
 * 「いつ・どれだけ書いたか」を日ごとに積む。作品の現在の文字数は
 * 走査すればいつでも分かるが、**書いた量は記録しておかないと二度と分からない**。
 */

/**
 * 統計ファイルの様式版。読めない版は捨てる（想像で補わない）。
 *
 * **ファイル別の内訳を足しても上げない**（作者の指示、2026-08-29
 * 「記録の持ち方を細かくして。集計画面等でおかしくならないように」）。
 * 足したのは**省略できる項目だけ**なので、古い版の拡張機能がこの記録を
 * 読んでも、知らない項目を読み飛ばして今までどおり動く。版を上げると、
 * **古い版はファイルごと捨てて記録が消える**（`parseDeviceWritingStats`）。
 * 同期で他の環境の記録も読むので、そこが壊れると被害は端末1台では済まない。
 */
export const WRITING_STATS_SCHEMA_VERSION = "1";

/** ファイル1件ぶんの文字数（内訳で使う） */
export interface FileCounts {
  net: number;
  gross: number;
}

/**
 * ファイル別の内訳。鍵は作品フォルダーからの相対パス（区切りは `/`）。
 *
 * **合計（net/gross）が正で、これは補助である。** 内訳の無い日
 * （この機能より前の記録）と有る日が混ざるので、集計・グラフ・目標・
 * ステータスバーは**内訳を読まない**。読むのは「このファイルで今日
 * 何字書いたか」を出すところだけ。
 */
export type FileCountMap = Record<string, FileCounts>;

/** 1日分の執筆量 */
export interface DailyStat {
  /** 日付境界を適用した YYYY-MM-DD */
  date: string;
  /** 純文字数の増減。消した日は負になる */
  net: number;
  /** 総文字数の増減 */
  gross: number;
  /** その日に記録が付いた回数（保存のたびに1増える） */
  saves: number;
  /**
   * ファイル別の内訳。**古い記録には無い**ので、必ず省略を想定して読む。
   * 合計とは別に積む（内訳が欠けても合計は正しいまま）。
   */
  files?: FileCountMap;
}

/**
 * 前回測ったときの作品の姿。
 *
 * 差を取るための基準であって、統計そのものではない。
 * ファイル数と競合数まで持つのは、**増減の原因が執筆かどうかを
 * 見分けるため**である（`recordMeasurement` を参照）。
 */
export interface WritingBaseline {
  net: number;
  gross: number;
  /** 走査したファイル数 */
  fileCount: number;
  /** 競合を含むため集計から外したファイル数 */
  conflictedCount: number;
  /** 測った時刻 (ISO8601) */
  at: string;
  /**
   * ファイル別の**現在値**（増減ではない）。次回の差を取るための基準。
   * 前の版が書いた記録には無いので、省略を想定して読む。
   */
  files?: FileCountMap;
}

/** 端末1台ぶんの記録。作品フォルダーの .aiwriter/stats/<端末ID>.json */
export interface DeviceWritingStats {
  schemaVersion: string;
  deviceId: string;
  /** 一度も測っていなければ無い */
  baseline?: WritingBaseline;
  /** 日付の昇順 */
  days: DailyStat[];
}

/** 作品を走査して得た「今の姿」。記録の入力になる */
export interface WritingMeasurement {
  net: number;
  gross: number;
  fileCount: number;
  conflictedCount: number;
  /**
   * ファイル別の現在値。**渡さなくてもよい**——渡さなければ内訳を
   * 積まないだけで、合計はこれまでどおり数える。
   */
  files?: FileCountMap;
}
