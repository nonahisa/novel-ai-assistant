import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * サブタイトルを付けた改名でも、原稿エディターの見た目を引き継ぎ、
 * 元の名前の面を閉じる（設計書6.25.5・6.12.1）。
 *
 * 本文の .md 化では引き継いでいたが、右クリックの「ファイル名にサブタイトルを
 * 付ける」とサブタイトル案の採用では抜けていた。見た目は原稿のパスごとに
 * メモリへ覚えているので、名前が変わると既定（横書き）へ戻っていた。
 * `renameCarriesAppearance.test.ts` と同じく、配線が戻っていないことをソースの形で押さえる。
 */
const read = (p: string) =>
  readFileSync(resolve(__dirname, "../../../", p), "utf8");

describe("サブタイトルの改名でも見た目を引き継ぐ", () => {
  test("右クリックの改名：名前を変える前に持ち越し、変えたあとに閉じる", () => {
    const src = read("src/features/episodeCopy.ts");
    const body = src.slice(src.indexOf("export async function renameWithSubtitle("));
    const carry = body.indexOf("carryAppearanceToRenamed(episode.filePath, target)");
    const rename = body.indexOf("vscode.workspace.fs.rename(");
    const close = body.indexOf("closeRenamedManuscript(episode.filePath)");
    expect(carry).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(carry);
    expect(close).toBeGreaterThan(rename);
  });

  test("改名の口 renameEpisodeFile：前後に手当てを差し込める（core から features は呼べない）", () => {
    const src = read("src/core/episodeRename.ts");
    const carry = src.indexOf("hooks?.beforeRename?.(file.filePath, target)");
    const rename = src.indexOf("vscode.workspace.fs.rename(");
    const close = src.indexOf("hooks?.afterRename?.(file.filePath)");
    expect(carry).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(carry);
    expect(close).toBeGreaterThan(rename);
  });

  test("サブタイトル案の採用は、その手当てを渡している", () => {
    const src = read("src/features/generateSynopses.ts");
    const call = src.slice(src.indexOf("await renameEpisodeFile("));
    expect(call.slice(0, 600)).toContain("beforeRename: carryAppearanceToRenamed");
    expect(call.slice(0, 600)).toContain("afterRename: closeRenamedManuscript");
  });
});
