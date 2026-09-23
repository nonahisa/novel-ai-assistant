import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * 予定の話を足す口（設計書6.4.8。作者の依頼、2026-09-23）が、
 * **単話プロットだけを作り、本文のファイルを作らない**ことを見張る。
 *
 * パネルは `vscode` の画面そのものなので動かせない。`episodePlotNoOverwrite`
 * と同じく**ソースを読んで、その関数の本体だけを調べる**形にする。
 * 見ているのは書き方の形で、実際にファイルが1つだけできることの確認は
 * 実機側に残る。それでも「予定を足したら空の本文も作っておこう」という
 * 書き換えはここで止まる。
 */

function bodyOf(file: string, marker: string): string {
  const source = readFileSync(path.join("src", "features", file), "utf-8")
    // コメントに書いた言葉で検査が通らないよう、先に落とす
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${marker} が見つかりません`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${marker} の閉じ括弧が見つかりません`);
}

describe("予定の話を足す", () => {
  const body = bodyOf("plotModePanel.ts", "private async addPlannedEpisode(");

  it("書き込みは既存の createEpisodePlot だけを通る", () => {
    expect(body).toContain("createEpisodePlot(");
    // 自前の書き込みを持たない（新規作成だけの道を迂回しない）
    expect(body).not.toMatch(/atomicWriteFile|writeTextFile|fs\.writeFile|writePlotText/);
  });

  it("本文のファイルを作らない（話を足す既存の道を呼ばない）", () => {
    expect(body).not.toMatch(/addEpisode|writeNewEpisodes|nameNewEpisodes/);
  });

  it("何話目かは、本文のある話数・プロットのある話数を断ってから決める", () => {
    expect(body).toContain("parsePlannedEpisodeNumber(");
    expect(body).toContain("validateInput");
  });

  it("本文を読めなかったときは足さない", () => {
    const guard = body.indexOf("episodesLoaded");
    const write = body.indexOf("createEpisodePlot(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });
});
