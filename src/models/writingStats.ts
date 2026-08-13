/**
 * 執筆量の記録（設計書6.3・5.5.6）。
 *
 * 「いつ・どれだけ書いたか」を日ごとに積む。作品の現在の文字数は
 * 走査すればいつでも分かるが、**書いた量は記録しておかないと二度と分からない**。
 */

/** 統計ファイルの様式版。読めない版は捨てる（想像で補わない） */
export const WRITING_STATS_SCHEMA_VERSION = "1";

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
}
