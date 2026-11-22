import { describe, expect, it } from "vitest";
import { checkEpisodeRename, checkSubtitleRetitle, currentFileTitle } from "../../../src/core/episodeRenameName";

describe("checkEpisodeRename（改名で話数・日付・種類を変えない）", () => {
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

describe("checkSubtitleRetitle（サブタイトルの付け直し）", () => {
  it("すでに題の付いた話の題を打ち直せる（話数と拡張子は残す）", () => {
    expect(checkSubtitleRetitle("episode_0003_転生.txt", "転生した朝")).toEqual({
      ok: true,
      fileName: "episode_0003_転生した朝.txt",
    });
  });

  it("題の無い話に題を付けられる", () => {
    expect(checkSubtitleRetitle("episode_0007.md", "雨の日")).toEqual({
      ok: true,
      fileName: "episode_0007_雨の日.md",
    });
  });

  it("日付で並ぶ話（SNS記事など）も、日付を残して題だけ変える", () => {
    const result = checkSubtitleRetitle("2026-08-16_朝.md", "昼");
    expect(result).toEqual({ ok: true, fileName: "2026-08-16_昼.md" });
  });

  it("空・いまと同じ題は断る", () => {
    expect(checkSubtitleRetitle("episode_0003_転生.txt", "  ").ok).toBe(false);
    expect(checkSubtitleRetitle("episode_0003_転生.txt", "転生").ok).toBe(false);
  });

  it("話数の無い種類の話（閑話）は、種類の語を残して題を付け直す（積み重ねない）", () => {
    expect(checkSubtitleRetitle("閑話.txt", "星の夜")).toEqual({ ok: true, fileName: "閑話_星の夜.txt" });
    expect(currentFileTitle("閑話_星の夜.txt")).toBe("星の夜");
    expect(checkSubtitleRetitle("閑話_星の夜.txt", "月の朝")).toEqual({ ok: true, fileName: "閑話_月の朝.txt" });
  });

  it("話数も日付も種類も無い名前（創作メモ集など）は、名前全体を題として入れ替える（積み重ねない）", () => {
    // アイデア_題1.md が アイデア_題1_題2.md になっていた（2026-11-22 に見つけた）
    expect(currentFileTitle("アイデア.md")).toBe("アイデア");
    expect(checkSubtitleRetitle("アイデア.md", "港町の話")).toEqual({ ok: true, fileName: "港町の話.md" });
    expect(checkSubtitleRetitle("港町の話.md", "山の話")).toEqual({ ok: true, fileName: "山の話.md" });
  });

  it("打った題で話数や種類の読みが変わる名前は断る", () => {
    expect(checkSubtitleRetitle("アイデア.md", "第3話").ok).toBe(false);
    expect(checkSubtitleRetitle("アイデア.md", "幕間").ok).toBe(false);
  });
});
