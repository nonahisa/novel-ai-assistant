import * as vscode from "vscode";
import type { CharCounts } from "../models/types";

/**
 * 文字数の数え方の設定（設計書6.4）。
 *
 * **どの画面でも同じ数え方にする。** 以前はこの設定がステータスバーにしか
 * 効いておらず、作品一覧はいつも純文字数だった。総文字数を選んでいる作者には、
 * **右下と一覧で違う数字が出続けていた**（2026-08-21、作者の指摘）。
 *
 * ## 執筆量の記録には効かせない
 *
 * 日次・週次の執筆量と目標は**純文字数で固定する。** 記録は日ごとに積んで
 * あるので、途中で基準を変えると**過去の記録と地続きでなくなる。**
 * 「今日の増分」が数え方の変更ぶんだけ跳ねることになる。
 */

export type CountMode = "net" | "gross";

export const DEFAULT_COUNT_MODE: CountMode = "net";

/** 設定値を読み取る。知らない値は既定（純文字数）に倒す */
export function parseCountMode(raw: string | undefined): CountMode {
  return raw === "gross" ? "gross" : DEFAULT_COUNT_MODE;
}

/** いまの数え方 */
export function currentCountMode(): CountMode {
  return parseCountMode(
    vscode.workspace
      .getConfiguration("novelai")
      .get<string>("countMode", DEFAULT_COUNT_MODE)
  );
}

/** 数え方に合わせて、どちらの数字を出すか選ぶ */
export function pickCount(counts: CharCounts, mode: CountMode): number {
  return mode === "gross" ? counts.gross : counts.net;
}

/**
 * 数字の前に添える短い印。
 *
 * **純文字数のときは何も付けない。** 既定なので、付けると全画面が
 * 「純」だらけになって読みにくい。既定から外れているときだけ知らせる。
 */
export function countModeLabel(mode: CountMode): string {
  return mode === "gross" ? "総" : "";
}

/** ルビの読み側を文字数から外すか（Markdownのみ対象） */
export function excludeRubyFromCount(): boolean {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>("excludeRubyFromCount", true);
}

/**
 * その設定変更で、数え直しが要るか。
 *
 * **ルビの扱いは走査のときに効く**ので、変わったらファイルを読み直す。
 * 純／総の切り替えは両方を数えてあるので、表示を作り直すだけでよい。
 */
export function needsRescan(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration("novelai.excludeRubyFromCount");
}

/** その設定変更で、表示を作り直す必要があるか */
export function needsRedraw(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration("novelai.countMode") || needsRescan(event);
}
