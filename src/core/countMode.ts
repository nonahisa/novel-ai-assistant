import type { CharCounts } from "../models/types";

/**
 * 文字数の数え方（純／総）と、その選び分け（設計書6.4）。
 *
 * **VS Code に依存しない。** 設定を読む `countSettings.ts` は `vscode` を持つので、
 * 画面なしで数える所（`episodeCharTable.ts` など）はこちらを使う。
 * 選び分け（`pickCount`）は**ここ1か所だけ**に書く（`countSettings.test.ts` が見張る）。
 * `countSettings.ts` は同じものを書き出し直している。
 */

export type CountMode = "net" | "gross";

/** 数え方に合わせて、どちらの数字を出すか選ぶ */
export function pickCount(counts: CharCounts, mode: CountMode): number {
  return mode === "gross" ? counts.gross : counts.net;
}
