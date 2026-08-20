import { describe, it, expect } from "vitest";
import { isCollectedFile } from "../../src/core/episodeLabel";

describe("isCollectedFile", () => {
  it("2話以上なら合本として扱う", () => {
    expect(isCollectedFile(2)).toBe(true);
    expect(isCollectedFile(219)).toBe(true);
  });

  it("1話しか入っていないものは合本ではない", () => {
    // 投稿サイトのダウンロードには、1話ずつ別ファイルなのに区切り行
    //（エピソードN開始）が入っている形がある。`parseCollectedFile` は
    // 区切り行が1つでもあれば話に分けて返すので、全ファイルに
    //「1話ぶん」の印が付いていた（2026-08-21、作者が実機で気づいた）
    expect(isCollectedFile(1)).toBe(false);
  });

  it("合本でないファイルは印を付けない", () => {
    expect(isCollectedFile(null)).toBe(false);
    expect(isCollectedFile(undefined)).toBe(false);
    expect(isCollectedFile(0)).toBe(false);
  });
});
