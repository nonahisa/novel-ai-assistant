import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 外で書き換わった本文に追いつく（設計書6.25.7、実機確認 A-20）。
 *
 * 本物の VS Code 1.90 で測ったところ、**ワークスペースの外にある本文は、
 * タブが裏に回っていると読み直されない**。ファイル1本ぶんの監視を張るだけで
 * 読み直されるようになる。監視が消えると、外の本文が古いまま画面に残る。
 * 源の形で見張る（resolveCustomTextEditor を代役で組むには依存が多すぎる）。
 */
const source = readFileSync(
  resolve(__dirname, "../../src/features/manuscriptEditor.ts"),
  "utf8"
);

function body(): string {
  const start = source.indexOf("async resolveCustomTextEditor(");
  const end = source.indexOf("private async verifyReloaded(", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("原稿エディタが外の変更に追いつく", () => {
  test("開いた本文そのものの監視を張り、閉じるときに捨てる", () => {
    const code = body();
    expect(code).toContain("createFileSystemWatcher(");
    expect(code).toContain("new vscode.RelativePattern(");
    // 監視は購読の束に入れて、パネルと一緒に捨てる
    expect(code).toMatch(/subscriptions\.push\(\s*watcher/);
  });

  test("表示に戻ったら送り直す", () => {
    const code = body();
    expect(code).toContain("panel.onDidChangeViewState(");
    expect(code).toMatch(/event\.webviewPanel\.visible\) void send\(\)/);
  });

  test("外からの変更を送った事実をログに残す（自分の書き換えは除く）", () => {
    const code = body();
    expect(code).toContain("外で変わったので画面へ送り直します");
    expect(code).toMatch(/if \(!selfEditing && event\.contentChanges\.length > 0\)/);
    // 自分の applyEdit のあいだだけ selfEditing が立つ
    expect(code).toMatch(/selfEditing = true;[\s\S]*?await this\.applyEdit\(document, text\);[\s\S]*?selfEditing = false;/);
  });

  test("読み直されなかったときはログに残す", () => {
    expect(source).toContain("private async verifyReloaded(");
    expect(source).toContain("VS Code が文書を読み直していません");
  });
});
