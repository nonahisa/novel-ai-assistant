import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { allActions } from "../../src/views/actionList";
import { STEP_REFERENCED_COMMANDS } from "../../src/views/stepMenu";

/**
 * 確認リストが指す操作は、画面のどこかから押せる（実機確認リスト全節の下ごしらえ）。
 *
 * **これまでは「メニューを探して見つからない」で気づいていた。**
 * 実機で確かめる人は、節の `<!-- 対象: novelai.xxx -->` を見て操作を探す。
 * どこにも出ていない操作を指していると、**探す時間が丸ごと無駄になる**
 * （作者の指示、2026-09-08「機械にできるものを統合テストへ」）。
 *
 * 既にあるものと重ねない：
 * - `pendingChecks.test.ts` … そのIDが `package.json` に**実在するか**
 * - ここ … その操作へ**辿り着けるか**（詳細メニュー・簡単ステップ・右クリック）
 */

const LIST = "docs/実機確認リスト.md";

/** 確認リストの `<!-- 対象: … -->` を、節の番号つきで拾う */
function targetsInList(): Array<{ section: string; command: string }> {
  const lines = readFileSync(LIST, "utf8").split("\n");
  const found: Array<{ section: string; command: string }> = [];
  let section = "（番号なし）";

  for (const line of lines) {
    const heading = /^###\s+([A-Za-z]+-\d+)\./.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    const target = /^<!--\s*対象:\s*(.+?)\s*-->/.exec(line);
    if (!target) continue;
    for (const command of target[1].split(",")) {
      const trimmed = command.trim();
      if (trimmed) found.push({ section, command: trimmed });
    }
  }
  return found;
}

/** 画面から押せる操作。3つの入口をすべて数える */
function reachableCommands(): Set<string> {
  const reachable = new Set<string>();

  // ① 詳細メニュー（分類→小分類→操作）
  for (const action of allActions()) reachable.add(action.command);
  // ② 簡単ステップ。実体は ACTION_TREE にあり、こちらはIDで参照している
  for (const command of STEP_REFERENCED_COMMANDS) reachable.add(command);
  // ③ 右クリック・ビューのタイトルのボタン（章立てや話の挿入はここだけ）
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    contributes: { menus: Record<string, Array<{ command?: string }>> };
  };
  for (const entries of Object.values(manifest.contributes.menus)) {
    for (const entry of entries) {
      if (entry.command) reachable.add(entry.command);
    }
  }

  return reachable;
}

describe("確認リストの指す操作へ、画面から辿り着ける", () => {
  const targets = targetsInList();
  const reachable = reachableCommands();

  test("読み取れる形で書かれている（節と対象が拾える）", () => {
    // 書式が変わって0件になったら、下の検査が素通りしてしまう
    expect(targets.length).toBeGreaterThan(50);
    for (const target of targets) {
      expect(target.command, target.section).toMatch(/^novelai\./);
    }
  });

  test("どの操作も、メニュー・簡単ステップ・右クリックのどれかに出ている", () => {
    const orphans = targets
      .filter((target) => !reachable.has(target.command))
      .map((target) => `${target.section}: ${target.command}`);

    expect([...new Set(orphans)]).toEqual([]);
  });
});
