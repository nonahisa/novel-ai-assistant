import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { allActions } from "../../src/views/actionList";

/**
 * タブの題は、メニューの名前と揃える（作者の裁定、2026-09-06）。
 *
 * メニューは「全作品の執筆統計を表示」なのに、開いたタブは
 * 「全作品の執筆量」だった。**押したものと開いたものの名前が違うと、
 * 作者は目的の画面が開いたのかどうかを名前で確かめられない。**
 *
 * ここは**書いてあるコードの形**で見る。パネルを開く処理は VS Code の
 * API を呼ぶので単体では動かせない（`chatRunEntry.test.ts` と同じやり方）。
 */

/** 「〜を表示」を落とした、画面そのものの名前 */
function screenName(command: string): string {
  const action = allActions().find((entry) => entry.command === command);
  if (!action) throw new Error(`操作「${command}」がありません`);
  return action.label.replace(/を表示$/, "");
}

describe("執筆統計の画面の題", () => {
  const allWorks = readFileSync(
    "src/features/allWorksWritingStatsPanel.ts",
    "utf8"
  );
  const perWork = readFileSync("src/features/writingStatsPanel.ts", "utf8");

  test("全作品の画面は、メニューと同じ名前で開く", () => {
    const name = screenName("novelai.showAllWorksWritingStats");

    expect(name).toBe("全作品の執筆統計");
    // VS Code のタブの題と、画面の中の見出しの両方
    expect(allWorks.split(`"${name}"`).length - 1).toBe(2);
  });

  test("作品ごとの画面も、メニューと同じ名前で開く", () => {
    const name = screenName("novelai.showWritingStats");

    expect(name).toBe("執筆統計");
    expect(perWork).toContain(`\`${name}: \${work.title}\``);
    expect(perWork).toContain(`\`\${work.title} の${name}\``);
  });

  test("古い題（執筆量）はタブに残っていない", () => {
    // 画面の中の「執筆量」の言葉そのものは残る（数える対象の名前なので）。
    // ここで見るのは**タブと見出しの題**だけ
    expect(allWorks).not.toContain('"全作品の執筆量"');
    expect(perWork).not.toContain("執筆量: ${work.title}");
    expect(perWork).not.toContain("${work.title} の執筆量");
  });
});
