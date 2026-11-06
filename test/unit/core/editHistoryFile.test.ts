import { describe, expect, test } from "vitest";
import * as nodePath from "path";
import { editHistoryFile } from "../../../src/core/editHistoryFormat";
import { recordPointsToEpisode } from "../../../src/core/episodeTimeline";

/**
 * 編集履歴の `file` に入れる形（作品フォルダーからの相対・`/` 区切り）。
 * 名前だけを書いていたので、別の章の同じ名前の話と取り違えていた（0.130.4）。
 */
const work = nodePath.join("C:", "小説", "氷の街");
const chapter1 = nodePath.join(work, "本文", "第1章", "Episode_0001.md");
const chapter2 = nodePath.join(work, "本文", "第2章", "Episode_0001.md");

describe("editHistoryFile", () => {
  test("作品の中は、/ 区切りの相対パス（大小は変えない）", () => {
    expect(editHistoryFile(work, chapter1)).toBe("本文/第1章/Episode_0001.md");
  });

  test("作品の外は、場所をそのまま残す", () => {
    const outside = nodePath.join("C:", "小説", "別の作品", "001.md");
    expect(editHistoryFile(work, outside)).toBe(outside);
  });

  test("空なら空", () => {
    expect(editHistoryFile(work, "")).toBe("");
  });

  test("ブラウザ版：符号化された文書の場所でも、作品からの相対になる", () => {
    const folder = "vscode-vfs://github/owner/repo/氷の街";
    const document =
      "vscode-vfs://github/owner/repo/%E6%B0%B7%E3%81%AE%E8%A1%97/%E6%9C%AC%E6%96%87/001.md";
    expect(editHistoryFile(folder, document)).toBe("本文/001.md");
  });

  test("タイムラインは、書いた話だけを指し、ほかの章の同じ名前の話を指さない", () => {
    const file = editHistoryFile(work, chapter1);
    expect(recordPointsToEpisode(file, work, chapter1)).toBe(true);
    expect(recordPointsToEpisode(file, work, chapter2)).toBe(false);
  });

  test("0.130.3 までの名前だけの記録も、これまでどおり読める", () => {
    expect(recordPointsToEpisode("Episode_0001.md", work, chapter1)).toBe(true);
  });
});
