import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `commitAll`（`git add -A` して記録する）を呼ぶファイルは、同じファイルで GitHub に送れない
 * 大きさのファイルを見ている、を見張る（設計書5.5.21）。
 *
 * 2026-11-14 の作者の実機で 722MB の zip が記録に入り、送信が断られ続けた。記録の前の検査は
 * 「すべて同期」と単独の同期にしか無く、ほかの記録の道（変更の記録・最初の記録・復元・
 * 分岐を合わせる前・編集部へ渡す）は素通りしていた。**新しい呼び出し元が検査を忘れたら落ちる。**
 *
 * 見るのは名前だけ（`findLargeFilesToRecord` か、知らせまで出す `stopIfTooLargeToRecord`）。
 * 呼ぶ順や道までは見ない——そこは呼び出し元ごとのテスト（`largeFilesBeforeCommit.test.ts`）が見る。
 */
const SRC = path.resolve(__dirname, "../../../src");
/** 定義の所。ここは呼び出し元ではない */
const DEFINITION = path.join("core", "gitSetup.ts");
const GUARDS = ["findLargeFilesToRecord", "stopIfTooLargeToRecord"];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("commitAll を呼ぶ所は、記録の前に大きさを見る", () => {
  const callers = sourceFiles(SRC)
    .filter((file) => path.relative(SRC, file) !== DEFINITION)
    .filter((file) => /\bcommitAll\(/.test(fs.readFileSync(file, "utf8")));

  test("呼び出し元が見つかる（見張りが空振りしていない）", () => {
    // 2026-11-16 の時点で6ファイル（gitOnboarding・gitRestore・gitSync・resolveDivergence・
    // shareWithEditor・syncAllWorks）。減ったなら、探し方が壊れていないかを先に疑う
    expect(callers.length).toBeGreaterThanOrEqual(6);
  });

  test("どの呼び出し元も、同じファイルで大きさの検査を呼んでいる", () => {
    const missing = callers
      .filter((file) => {
        const text = fs.readFileSync(file, "utf8");
        return !GUARDS.some((name) => new RegExp(`\\b${name}\\(`).test(text));
      })
      .map((file) => path.relative(SRC, file).replace(/\\/g, "/"));
    expect(
      missing,
      "記録の前に findLargeFilesToRecord か stopIfTooLargeToRecord で、100MB を超えるファイルを見てください（設計書5.5.21）"
    ).toEqual([]);
  });
});
