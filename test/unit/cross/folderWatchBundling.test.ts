import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 再帰の見張りは `FolderWatchHub` の1か所でしか張らない（残課題 C2、0.84.4）。
 *
 * VS Code 本体は、開いているフォルダーの外に**再帰の見張り**（パターンに
 * `**` か `/` を含む `RelativePattern`）を1本張るたびに、
 * `files.watcherExclude` の警告をログへ出す。作品16で42件出ていたのを、
 * 作品フォルダーごとに1本へ束ねて減らした。
 *
 * **新しい機能が自前で再帰の見張りを張ると、本数がまた増える。** 張るなら
 * ハブへ `subscribe` する。再帰しない見張り（1つのファイル・1つの
 * フォルダーの直下）は警告を出さないので、各機能が持っていてよい。
 */

const SOURCE_ROOT = "src";
const HUB = join("src", "features", "folderWatchHub.ts");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("見張りの張り方", () => {
  const files = sourceFiles(SOURCE_ROOT);
  const watching = files.filter((file) =>
    readFileSync(file, "utf8").includes("createFileSystemWatcher(")
  );

  it("見張りを張っている場所を洗い出せている（0件なら探し方が壊れている）", () => {
    expect(watching).toContain(HUB);
  });

  it("ハブの外で、再帰のパターン（`**` や `/` を含む）を渡していない", () => {
    const offenders: string[] = [];
    for (const file of watching) {
      if (file === HUB) continue;
      const code = readFileSync(file, "utf8");
      // `createFileSystemWatcher(` から、その呼び出しの終わりまで（最初の `);`）を見る
      let at = code.indexOf("createFileSystemWatcher(");
      while (at >= 0) {
        const end = code.indexOf(");", at);
        const call = code.slice(at, end < 0 ? at + 400 : end);
        if (/["`'][^"`']*(\*\*|\/)[^"`']*["`']/.test(call)) {
          offenders.push(`${file}: ${call.replace(/\s+/g, " ").slice(0, 160)}`);
        }
        at = code.indexOf("createFileSystemWatcher(", at + 1);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("本文・同期・設定資料・単話プロットの見張りはハブへ申し込む", () => {
    for (const file of [
      "workFolderWatch.ts",
      "gitSync.ts",
      "watchSettings.ts",
      "episodePlotWatch.ts",
    ]) {
      const code = readFileSync(join("src", "features", file), "utf8");
      expect(code, file).toContain("subscribe({");
      expect(code, file).not.toContain("createFileSystemWatcher(");
    }
  });

  it("製品の配線は、共有の1つを各機能へ渡している", () => {
    const extension = readFileSync(join("src", "extension.ts"), "utf8");
    expect(extension).toContain("const folderWatchHub = sharedFolderWatchHub();");
    expect(extension).toContain("context.subscriptions.push(folderWatchHub);");
    // 同期
    expect(extension).toMatch(/GitSyncMonitor\(registry, \{\s*folderWatchHub,?\s*\}\)/);
    // 本文
    expect(extension).toMatch(/new WorkFolderWatchers\([\s\S]{0,200}?\}, folderWatchHub\)/);
    // 設定資料（`new SettingsWatcher(` の呼び出しの中で渡している）
    const at = extension.indexOf("new SettingsWatcher(");
    const close = extension.indexOf("context.subscriptions.push(settingsWatcher)", at);
    expect(at).toBeGreaterThan(-1);
    expect(extension.slice(at, close)).toContain("folderWatchHub");
    // 単話プロット（パネルは extension.ts を通らずに作られる）
    const plotPanel = readFileSync(join("src", "features", "plotModePanel.ts"), "utf8");
    expect(plotPanel).toMatch(/new EpisodePlotFolderWatcher\([\s\S]*?sharedFolderWatchHub\(\)\)/);
  });
});
