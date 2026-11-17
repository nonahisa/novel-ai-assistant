import { describe, expect, test } from "vitest";
import * as path from "node:path";
import { gitignoreForDrive } from "../../../src/core/driveGitignore";
import { isIgnoredSyncPath, isSendableSyncPath } from "../../../src/core/driveSyncPlan";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/**
 * 作者が自分で .gitignore に書いた行を、ドライブへ送るときにも守る（設計書5.10.9）。
 * 読める形だけを読み、読めない行は勝手に解釈せず、行の番号と中身を返す（知らせに出す）。
 */

const ignored = (text: string, entry: string) => isIgnoredSyncPath(entry, gitignoreForDrive(text).rules);

describe("読める形", () => {
  test("根からの道（途中に「/」）は根から当てる。末尾の「/」はフォルダーだけ", () => {
    const text = "資料/下書き/\nメモ/秘密.txt\n";
    expect(ignored(text, "資料/下書き/a.txt")).toBe(true);
    expect(ignored(text, "本文/資料/下書き/a.txt")).toBe(false);
    expect(ignored(text, "メモ/秘密.txt")).toBe(true);
    expect(ignored(text, "メモ/秘密.txt.bak")).toBe(false);
  });

  test("「/」の無い名前は、どの深さでも当たる。フォルダーに当たれば中も全部", () => {
    const text = "下書き\n*.bak\n";
    expect(ignored(text, "下書き")).toBe(true);
    expect(ignored(text, "本文/下書き/a.txt")).toBe(true);
    expect(ignored(text, "本文/第1話.txt.bak")).toBe(true);
    expect(ignored(text, "本文/第1話.txt")).toBe(false);
  });

  test("末尾の「/」は、同じ名前のファイルには当たらない", () => {
    const text = "作業/\n";
    expect(ignored(text, "作業")).toBe(false);
    expect(ignored(text, "作業/a.txt")).toBe(true);
  });

  test("先頭の「/」は根に留める。「*」「?」は区切りをまたがない", () => {
    const text = "/表紙.png\n第?話.tmp\n本文/*.log\n";
    expect(ignored(text, "表紙.png")).toBe(true);
    expect(ignored(text, "画像/表紙.png")).toBe(false);
    expect(ignored(text, "本文/第1話.tmp")).toBe(true);
    expect(ignored(text, "本文/a.log")).toBe(true);
    expect(ignored(text, "本文/下/a.log")).toBe(false);
  });

  test("「**」は区切りごと（頭・途中・終わり）", () => {
    const text = "**/作業メモ.md\n資料/**/古い\n控え/**\n";
    expect(ignored(text, "作業メモ.md")).toBe(true);
    expect(ignored(text, "本文/第1章/作業メモ.md")).toBe(true);
    expect(ignored(text, "資料/古い")).toBe(true);
    expect(ignored(text, "資料/a/b/古い/x.txt")).toBe(true);
    expect(ignored(text, "控え/a/b.txt")).toBe(true);
    expect(ignored(text, "控え")).toBe(false);
  });

  test("Windows と同じく、大文字小文字と末尾の「.」・空白を区別しない", () => {
    const text = "Drafts/\n";
    expect(ignored(text, "drafts/a.txt")).toBe(true);
    expect(ignored(text, "DRAFTS./a.txt")).toBe(true);
  });

  test("空の行と「#」の行は読み飛ばす（読めない行にしない）。行末の空白は落とす", () => {
    const read = gitignoreForDrive("# 送らないもの\n\n下書き/   \r\n");
    expect(read.unreadable).toEqual([]);
    expect(isIgnoredSyncPath("下書き/a.txt", read.rules)).toBe(true);
  });

  test("決まった除外（IGNORED_PATHS）と並べても、送るものの判定が今までどおり", () => {
    const rules = gitignoreForDrive("*.bak\n").rules;
    expect(isSendableSyncPath("本文/第1話.txt", { ownDeviceId: "desk-a1b2", ignoredPaths: rules })).toBe(true);
    expect(isSendableSyncPath("本文/第1話.bak", { ownDeviceId: "desk-a1b2", ignoredPaths: rules })).toBe(false);
  });
});

describe("読めない形は解釈しない（行の番号と中身を返す）", () => {
  test("否定の「!」・文字の組「[...]」・円記号・「**」の混ざった区切り", () => {
    const text = "*.bak\n!大事.bak\n第[1-3]話.txt\n\\#メモ\na**b\n";
    const read = gitignoreForDrive(text);
    expect(read.unreadable).toEqual([
      { line: 2, text: "!大事.bak" },
      { line: 3, text: "第[1-3]話.txt" },
      { line: 4, text: "\\#メモ" },
      { line: 5, text: "a**b" },
    ]);
    // 読めない行は当てない（否定で戻したつもりのファイルを、こちらの勝手で戻さない・外さない）
    expect(isIgnoredSyncPath("第1話.txt", read.rules)).toBe(false);
    // 読める行は読む
    expect(isIgnoredSyncPath("大事.bak", read.rules)).toBe(true);
  });

  test("作品の外を指す行（「..」）は読めない", () => {
    expect(gitignoreForDrive("../外.txt\n").unreadable).toEqual([{ line: 1, text: "../外.txt" }]);
  });
});

describe("モバイル版へそのまま持っていける", () => {
  test("driveGitignore.ts から静的にたどれる先に、vscode・node:・core/paths.ts が無い", () => {
    const reach = walkStaticImports([path.join(SRC, "core", "driveGitignore.ts")]);
    const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
    expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
    const paths = path.join(SRC, "core", "paths.ts");
    expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
  });
});
