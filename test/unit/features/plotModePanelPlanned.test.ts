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

/**
 * 名前の形が違う単話プロット（`episode_0005.md`）を、黙って消えたように
 * 見せない（2026-09-26 精査 R11 ③）。並べる判定は core の
 * `misnamedEpisodePlots`（`test/unit/core/misnamedEpisodePlots.test.ts`）、
 * ここはパネルがそれを知らせに出し、**名前を変えない**ことだけを見る。
 */
describe("名前の形が違う単話プロット", () => {
  const body = bodyOf("plotModePanel.ts", "private async existingEpisodePlots(");

  it("置き場を読んだときに、形の違う名前を知らせに足す", () => {
    expect(body).toContain("misnamedEpisodePlots(");
    expect(body).toContain("this.notices.push(");
  });

  it("名前を直す書き込みはしない（作者のファイル）", () => {
    expect(body).not.toMatch(/rename|atomicWriteFile|writeTextFile|fs\.write/);
  });
});
