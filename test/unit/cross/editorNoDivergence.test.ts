import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 編集者モードでは「分岐合流」（`novelai.resolveDivergence`）を使えなくする
 * （作者の判断 2026-11-02。洗い出し2回目の10）。
 *
 * 許可の表（`editorMode.ts`）から外すだけでは、詳細メニューが灰色になるだけで、
 * **知らせのボタンからは今までどおり呼ばれる**（表を見るのは詳細メニューの描画
 * だけ）。分かれたときに出る2か所のボタンと、命令の入口そのものを見る。
 */
const read = (file: string): string =>
  readFileSync(resolve(__dirname, "../../..", file), "utf8");

describe("編集者モードでは分岐合流へ渡さない", () => {
  test("開いたときの点検：分かれたら「校閲を終えて返す」のボタンを出す", () => {
    const source = read("src/features/handoffSync.ts");
    expect(source).toContain(
      "[editor ? finishReviewLabel() : CHOOSE_WHICH_TO_KEEP, \"あとで\"]"
    );
    expect(source).toContain(
      "await vscode.commands.executeCommand(FINISH_REVIEW_COMMAND);"
    );
  });

  test("すべて同期：受け取るだけの置き場が分かれたら「校閲を終えて返す」へ", () => {
    const source = read("src/features/syncAllWorks.ts");
    expect(source).toMatch(
      /divergedPlan\.receiveOnly\s*\?\s*\{\s*label: finishReviewLabel\(\),\s*command: FINISH_REVIEW_COMMAND,/
    );
    // 計画の段で外した分かれた置き場（結果を持たない）からも拾う（0.122.2）
    expect(source).toMatch(/plans\.find\(\(plan\) => plan\.skip === "editor_diverged"\)/);
  });

  test("命令の入口でも止めて、案内を出す", () => {
    const source = read("src/extension.ts");
    const start = source.indexOf('"novelai.resolveDivergence",\n      async');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 1200);
    expect(body).toContain("if (isEditorMode()) {");
    expect(body).toContain('describeBlocked("novelai.resolveDivergence")');
  });
});
