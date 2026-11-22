import { describe, expect, it } from "vitest";
import {
  checkEpisodeRename,
  episodeRenameInputValue,
  episodeRenameSelection,
} from "../../../src/core/episodeRenameName";

describe("checkEpisodeRename（作品一覧の［名前を変える］）", () => {
  it("題の部分だけ変えた名前は通し、拡張子は元のまま付ける", () => {
    expect(checkEpisodeRename("episode_0003_転生.txt", "episode_0003_転生した朝")).toEqual({
      ok: true,
      fileName: "episode_0003_転生した朝.txt",
    });
  });

  it("拡張子まで打っても二重にしない", () => {
    expect(checkEpisodeRename("episode_0003_転生.md", "episode_0003_旅立ち.md")).toEqual({
      ok: true,
      fileName: "episode_0003_旅立ち.md",
    });
  });

  it("題の無い話に題を付けられる", () => {
    expect(checkEpisodeRename("episode_0007.txt", "episode_0007_雨の日")).toEqual({
      ok: true,
      fileName: "episode_0007_雨の日.txt",
    });
  });

  it("話数の部分が変わる名前は断る（話数で指す記録が別の話を指すため）", () => {
    const result = checkEpisodeRename("episode_0003_転生.txt", "episode_0004_転生");
    expect(result.ok).toBe(false);
  });

  it("題に「幕間」などを入れて話の種類が変わる名前は断る", () => {
    const result = checkEpisodeRename("episode_0003_転生.txt", "幕間");
    expect(result.ok).toBe(false);
  });

  it("日付で並ぶ話は、日付の部分を変える名前を断る", () => {
    expect(checkEpisodeRename("2026-08-16_朝.md", "2026-08-16_昼").ok).toBe(true);
    expect(checkEpisodeRename("2026-08-16_朝.md", "2026-08-17_朝").ok).toBe(false);
  });

  it("話数の無い話（閑話.txt）は話数の無い名前どうしで変えられる", () => {
    expect(checkEpisodeRename("閑話.txt", "閑話_星の夜")).toEqual({
      ok: true,
      fileName: "閑話_星の夜.txt",
    });
  });

  it("空・同じ名前は断る", () => {
    expect(checkEpisodeRename("episode_0003_転生.txt", "   ").ok).toBe(false);
    expect(checkEpisodeRename("episode_0003_転生.txt", "episode_0003_転生").ok).toBe(false);
  });

  it("ファイル名に使えない字は全角へ直す（区切りでフォルダーを作らない）", () => {
    const result = checkEpisodeRename("episode_0003_転生.txt", "episode_0003_A/B");
    expect(result).toEqual({ ok: true, fileName: "episode_0003_A／B.txt" });
  });
});

describe("入力欄の初めの値と選ぶ範囲", () => {
  it("拡張子を外した名前を出し、題の部分を選んでおく", () => {
    expect(episodeRenameInputValue("episode_0003_転生.txt")).toBe("episode_0003_転生");
    expect(episodeRenameSelection("episode_0003_転生.txt")).toEqual([13, 15]);
  });

  it("題が読めなければ範囲を決めない（全体を選ぶ）", () => {
    expect(episodeRenameSelection("episode_0007.txt")).toBeUndefined();
  });
});
