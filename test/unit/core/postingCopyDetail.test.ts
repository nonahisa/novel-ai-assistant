import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { ACTION_TREE, type ActionItem, type ActionSection } from "../../../src/core/actionTree";
import { POSTING_SITES } from "../../../src/models/posting";

/**
 * 「コピー（投稿サイト用）」（0.96.15 までの「投稿用変換・コピー」）の説明文が、
 * いまの手順と食い違わない
 * （実機確認リスト D-1「投稿サイト用に変換してコピー」の2段）。
 *
 * 2段（記法→傍点があるときだけサイト）は 2026-09-06 の作者の裁定で
 * 「貼り付け先を1度だけ訊く」に変わった（`core/postingCopyTargets.ts`）。
 * ところがツールチップには「傍点が入っているときだけ貼り付け先を訊く」が
 * 残り、貼れる先にも note が無かった。説明を読んだ作者は、訊かれない
 * はずの画面が出たと受け取る。
 */
function findItem(command: string): ActionItem | undefined {
  const visit = (entry: ActionItem | ActionSection): ActionItem | undefined => {
    if (entry.kind === "action") return entry.command === command ? entry : undefined;
    for (const child of entry.items) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const group of ACTION_TREE) {
    for (const entry of group.entries) {
      const hit = visit(entry);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe("コピー（投稿サイト用）の説明", () => {
  const item = findItem("novelai.copyForPosting");

  /**
   * **名前は3つの入口で揃える**（作者の裁定、2026-10-03）。コマンドパレットと
   * .md の右クリック・作品一覧の話の右クリック・原稿エディターの右クリックが
   * それぞれ別の名前だった。何を写すかの違いは説明文で言う。
   */
  test("詳細メニュー・コマンドの名前は「コピー（投稿サイト用）」で、説明が写す元を言う", () => {
    expect(item?.label).toBe("コピー（投稿サイト用）");
    expect(item?.detail).toContain("開いているファイルの本文");
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { commands: Array<{ command: string; title: string }> };
    };
    const titleOf = (command: string) =>
      manifest.contributes.commands.find((entry) => entry.command === command)?.title;
    expect(titleOf("novelai.copyForPosting")).toBe("コピー（投稿サイト用）");
    expect(titleOf("novelai.copyBodyForPosting")).toBe("コピー（投稿サイト用）");
    const editor = readFileSync("src/views/manuscriptEditorHtml.ts", "utf8");
    expect(editor).toContain('add("コピー（投稿サイト用）"');
  });

  /*
    0.96.17：パレットに同じ名前が2つ並んでいた。作品一覧用（copyBodyForPosting）は
    話の節点が無いと何もしないので、前例（openEpisode）どおりパレットから隠す。
    上のバーのボタンと手順の札も同じ調子の名前へ揃える
  */
  test("コマンドパレットには1つだけ出る（作品一覧用は隠す）", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { menus: { commandPalette: Array<{ command: string; when?: string }> } };
    };
    const palette = manifest.contributes.menus.commandPalette;
    expect(palette.find((entry) => entry.command === "novelai.copyBodyForPosting")?.when).toBe(
      "false"
    );
    expect(palette.find((entry) => entry.command === "novelai.copyForPosting")).toBeUndefined();
  });

  test("上のバーのボタン・入口の案内・手順の札も「コピー（投稿サイト用）」", () => {
    const editor = readFileSync("src/views/manuscriptEditorHtml.ts", "utf8");
    expect(editor).toMatch(/<button id="copy"[^>]*>コピー（投稿サイト用）<\/button>/);
    const entrance = readFileSync("src/core/actionEntrance.ts", "utf8");
    expect(entrance).toContain("上のバー「コピー（投稿サイト用）」");
    const style = readFileSync("src/core/writerStyle.ts", "utf8");
    expect(style).toMatch(/command: "novelai\.copyForPosting",\s*label: "コピー（投稿サイト用）"/);
    for (const text of [editor, entrance, style]) {
      expect(text).not.toContain("投稿用にコピー");
      expect(text).not.toContain("投稿サイト用に変換してコピーする");
    }
  });

  test("傍点の有無で訊き方が変わる、という古い説明が残っていない", () => {
    expect(item).toBeDefined();
    expect(item?.detail).not.toContain("傍点が入っているときだけ");
    expect(item?.detail).toContain("貼り付け先");
  });

  test("貼れるサイトの名前が、投稿先の一覧と揃っている", () => {
    for (const site of POSTING_SITES) {
      expect(item?.detail, site.label).toContain(shortName(site.label));
    }
  });
});

/** 説明文では「小説家になろう」を「なろう」と縮めて書く */
function shortName(label: string): string {
  return label === "小説家になろう" ? "なろう" : label;
}
