import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * 予定の話の並べ替え・差し込み（設計書6.4.8。作者の依頼、2026-09-23）が、
 * **単話プロットの名前と見出しだけを動かし、本文のファイルに触れない**ことを
 * 見張る。
 *
 * パネルは `vscode` の画面そのものなので動かせない。`plotModePanelPlanned` と
 * 同じく**ソースを読んで、その関数の本体だけを調べる**形にする。付け替えの
 * 順序・衝突・巻き戻しは `test/unit/core/episodePlotOrder.test.ts` が本物の
 * 関数で確かめている。
 */

function source(file: string): string {
  return readFileSync(path.join("src", "features", file), "utf-8")
    // コメントに書いた言葉で検査が通らないよう、先に落とす
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function bodyOf(file: string, marker: string): string {
  const text = source(file);
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`${marker} が見つかりません`);
  const open = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`${marker} の閉じ括弧が見つかりません`);
}

describe("予定の話を動かす", () => {
  const move = bodyOf("plotModePanel.ts", "private async movePlanned(");
  const insert = bodyOf("plotModePanel.ts", "private async insertPlanned(");
  const apply = bodyOf("plotModePanel.ts", "private async applyMovePlan(");
  const rename = bodyOf("plotModePanel.ts", "private async renamePlotFile(");
  const headings = bodyOf("plotModePanel.ts", "private async renumberHeadings(");

  it("計画は core の関数だけが立てる（本文のある話数の判断を写さない）", () => {
    expect(move).toContain("planPlannedEpisodeStep(");
    expect(insert).toContain("planPlannedEpisodeInsert(");
  });

  it("本文を読めなかったときは動かさない", () => {
    for (const body of [move, insert]) {
      const guard = body.indexOf("episodesLoaded");
      const plan = body.indexOf("applyMovePlan(");
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(plan);
    }
  });

  it("止める計画なら理由を出し、何も付け替えない", () => {
    const blocked = apply.indexOf('plan.kind === "blocked"');
    const renames = apply.indexOf("applyEpisodePlotRenames(");
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked).toBeLessThan(renames);
    expect(apply).toContain("plan.reason");
  });

  it("書きかけの単話プロットがあれば止め、確認を取ってから付け替える", () => {
    const dirty = apply.indexOf("isDirtyDocument(");
    const confirm = apply.indexOf("modal: true");
    const renames = apply.indexOf("applyEpisodePlotRenames(");
    expect(dirty).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(dirty);
    expect(renames).toBeGreaterThan(confirm);
  });

  it("名前の付け替えは上書きしない（置き場の中だけ）", () => {
    expect(rename).toContain("overwrite: false");
    expect(rename).toContain("this.episodePlotsDir");
  });

  it("見出しの書き直しは、退避つきの書き戻しの口だけを通る", () => {
    expect(headings).toContain("renumberEpisodePlotHeading(");
    expect(headings).toContain("writeTextFilePreservingFormat(");
    expect(headings).not.toMatch(/atomicWriteFile|fs\.writeFile|writePlotText/);
  });

  it("本文のファイルを動かす道を呼ばない", () => {
    for (const body of [move, insert, apply, rename, headings]) {
      expect(body).not.toMatch(
        /applyRenumberPlan|planInsertion|planRemoval|renameEpisodeFile|writeNewEpisodes/
      );
      // 本文の場所（走査の結果）を名前変更の相手にしない
      expect(body).not.toMatch(/episode\.filePath|row\.filePath/);
    }
  });
});

describe("単話プロットを開く列", () => {
  it("パネルと重ならない列へ開く", () => {
    const column = bodyOf("plotModePanel.ts", "private documentColumn(");
    expect(column).toContain("this.panel.viewColumn");
    const open = bodyOf("plotModePanel.ts", "private async openEpisodePlot(");
    expect(open).toContain("this.documentColumn()");
  });
});
