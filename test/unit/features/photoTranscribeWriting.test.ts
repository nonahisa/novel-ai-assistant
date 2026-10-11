import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * 写真から起こした文を原稿へ書く道（設計書6.117.6。実装ルール1）。
 *
 * - 新しい話は「新しい話の作成」の既存の道（`writeNewEpisodes`。`mode: "create"`）だけ
 * - 開いている話へは `WorkspaceEdit`（Ctrl+Z で戻せ、保存は VS Code が文字コードを保って行う）
 * - 自前でファイルを書かない（`atomicWriteFile`・`fs.writeFile` を直に呼ばない）
 *
 * 画面を通す本物の確かめは E2E（この機械では走らせない）なので、ここでは
 * 書く道を取り違えていないことをソースで見張る。
 */
const SOURCE = fs.readFileSync(
  path.join(__dirname, "../../../src/features/photoTranscribe.ts"),
  "utf8"
);

describe("写真の書き起こしの書き込みの道", () => {
  test("新しい話は writeNewEpisodes を通す", () => {
    expect(SOURCE).toMatch(/await writeNewEpisodes\(/);
    expect(SOURCE).toMatch(/import \{ nameNewEpisodes, writeNewEpisodes \} from "\.\/addEpisodeFiles"/);
  });

  test("足したあとに一覧・執筆量の基準・原稿エディターの後始末を呼ぶ", () => {
    expect(SOURCE).toContain("deps.refreshTree(work)");
    expect(SOURCE).toContain("await deps.rebaseline(work)");
    expect(SOURCE).toContain("await deps.openEpisode(work, added)");
  });

  test("開いている話へは WorkspaceEdit で入れ、入れられたかを確かめる", () => {
    expect(SOURCE).toContain("new vscode.WorkspaceEdit()");
    expect(SOURCE).toMatch(/if \(!\(await vscode\.workspace\.applyEdit\(change\)\)\)/);
    // 新しく作る改行は文書の宣言に合わせる
    expect(SOURCE).toContain("fromLfText(insertion, target.document.eol === vscode.EndOfLine.CRLF)");
  });

  test("ファイルを直に書かない", () => {
    expect(SOURCE).not.toMatch(/atomicWriteFile\(/);
    expect(SOURCE).not.toMatch(/fs\.writeFile\(/);
    expect(SOURCE).not.toMatch(/writeTextFilePreservingFormat\(/);
  });

  test("path を直に読まない（ブラウザ版で壊れる。規則7）", () => {
    expect(SOURCE).toContain('import * as path from "../core/paths"');
    expect(SOURCE).not.toMatch(/from "(node:)?path"/);
    expect(SOURCE).not.toMatch(/Uri\.file\(/);
  });

  test("外へ送る確かめを、写真を送る前に毎回出す（「以降は訊かない」を付けない）", () => {
    const confirmAt = SOURCE.indexOf("describePhotoSend(");
    const generateAt = SOURCE.indexOf(".generate(");
    expect(confirmAt).toBeGreaterThan(0);
    expect(generateAt).toBeGreaterThan(confirmAt);
    // 「以降は訊かない」を覚える部品（`core/confirmMemory.ts` など）を引かない
    expect(SOURCE).not.toMatch(/confirmMemory|confirmRunOrChoose|ConfirmSkip/);
  });
});
