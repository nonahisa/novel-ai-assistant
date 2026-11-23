import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * **切り詰められた回の案内を、共通の部品で組む**（作者の決定 2026-11-23
 * 「途中で切れたと見分けて、次の操作を示すように直す」）。
 *
 * 「応答が出力上限で切り詰められました」だけを自前で書くと、次の一手が出ない。
 * 読める長さに届いて切れた回（`filledContextWindow`）や、関所が縮めた回
 * （`outputCappedByWindow`）に、直らない操作を勧めることにもなる。直し方の
 * 言い分けは `ai/outputLimit.ts` の `truncatedOutputAdvice` が1か所で持つ。
 *
 * 画面や呼び出し元へ出す流れを1本ずつ組むのは重いので、ここでは
 * 「自前の文が残っていないこと」と「共通の部品を通すこと」を文字で見張る。
 */
const SITES = [
  // 各話あらすじ
  "src/features/generateSynopses.ts",
  // 読みの確かめ
  "src/features/readingDictionary.ts",
  // 外部AIからの依頼：あらすじ（MCP）
  "src/features/runRequestRunners.ts",
  // 外部AIからの依頼：設定資料の抽出（MCP）
  "src/features/runRequestSettings.ts",
];

const ROOT = join(__dirname, "..", "..", "..");

describe("切り詰めの案内を共通の部品で組む", () => {
  test.each(SITES)("%s は自前の「切り詰められました」を持たない", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    expect(source).not.toContain("応答が出力上限で切り詰められました");
    expect(source).toContain("truncatedOutputAdvice(");
  });
});
