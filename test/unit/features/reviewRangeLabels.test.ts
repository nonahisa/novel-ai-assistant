import { describe, expect, test } from "vitest";
import { reviewEpisodeLabel, shortcutPickItem } from "../../../src/features/reviewProposals";

/**
 * 校閲の範囲を選ぶ一覧の行の名前（作者の報告 2026-11-05、編集者の環境で「重複するバグが出たみたいです」）。
 *
 * - 題が話数を含む話（「第1話 薄皮の向こう側」）で、「第1話　第1話 …」と二重になっていた
 * - 先頭の近道の行（「始めの話だけ」）が話の行と同じ名前で並び、同じ話が二度出たように見えた
 */

function episode(chapter: number | null, subtitle: string | null, fileName: string) {
  return { fileName, subtitle, kind: "本編" as const, chapterStart: chapter, chapterEnd: chapter, date: null, dateSeq: null };
}

describe("校閲の範囲の一覧：行の名前", () => {
  test("題が話数を含んでいても、話数は1回だけ", () => {
    expect(reviewEpisodeLabel(episode(1, "第1話 薄皮の向こう側", "episode_0001.md"))).toBe("第1話　薄皮の向こう側");
    expect(reviewEpisodeLabel(episode(3, "第３話　パンドラの箱【１】", "episode_0003.txt"))).toBe("第3話　パンドラの箱【１】");
  });

  test("題が話数を含まない・題が無い・題が話数だけ・話数が読めない話", () => {
    expect(reviewEpisodeLabel(episode(2, "海に沈む", "episode_0002.txt"))).toBe("第2話　海に沈む");
    expect(reviewEpisodeLabel(episode(5, null, "episode_0005.txt"))).toBe("第5話");
    expect(reviewEpisodeLabel(episode(5, "第5話", "episode_0005.txt"))).toBe("第5話");
    expect(reviewEpisodeLabel(episode(null, "幕間", "幕間.txt"))).toBe("幕間.txt");
  });

  test("近道の行は、話の行と見分けのつく名前になる", () => {
    const row = { label: "第1話　薄皮の向こう側", description: "episode_0001.md" };
    const shortcut = shortcutPickItem(row, "始めの話だけ");
    expect(shortcut.label).not.toBe(row.label);
    expect(shortcut.label).toContain("始めの話だけ：第1話　薄皮の向こう側");
    expect(shortcut.description).toBe("episode_0001.md");
  });
});
