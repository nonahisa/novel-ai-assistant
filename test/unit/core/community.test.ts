import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUG_REPORT_CHANNEL_URL, COMMUNITY_DISCORD_URL, bugReportSteps, pathForClipboard } from "../../../src/core/community";

/**
 * コミュニティ（Discord）への案内のリンク（1.0.0）。リンクは `core/community.ts` の1か所に置き、
 * README と Discord の計画書の「いまの状態」はそれに合わせる（招待が切れたとき、直し漏れを止める）。
 */
const root = path.join(__dirname, "..", "..", "..");

describe("コミュニティ（Discord）のリンク", () => {
  it("Discord の招待の形をしている", () => {
    expect(COMMUNITY_DISCORD_URL).toMatch(/^https:\/\/discord\.gg\/[A-Za-z0-9]+$/);
  });

  it("README の案内は、定義と同じリンクを書いている（ほかの招待を書いていない）", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    const invites = readme.match(/https:\/\/discord\.gg\/[A-Za-z0-9]+/g) ?? [];
    expect(invites.length).toBeGreaterThan(0);
    expect(new Set(invites)).toEqual(new Set([COMMUNITY_DISCORD_URL]));
  });
});

describe("［Discord で報告する］の行き先と手順（1.1.0）", () => {
  it("#不具合報告 のチャンネルのリンクの形をしている（サーバーとチャンネルの番号）", () => {
    expect(BUG_REPORT_CHANNEL_URL).toMatch(/^https:\/\/discord\.com\/channels\/\d+\/\d+$/);
  });

  it("手順は1行に1操作で番号が振ってあり、コマンドの名前と貼るキーが OS ごとに入る", () => {
    for (const [platform, keys] of [
      ["win32", "Ctrl+V"],
      ["darwin", "⇧⌘G"],
      ["linux", "Ctrl+L"],
    ] as const) {
      const steps = bugReportSteps(platform);
      steps.forEach((line, index) => expect(line.startsWith(`${index + 1}. `), line).toBe(true));
      const text = steps.join("\n");
      expect(text).toContain("/不具合を報告");
      expect(text).toContain("「添付」");
      expect(text, platform).toContain(keys);
    }
  });

  it("写す場所は Windows のドライブ文字を大文字にそろえる（VS Code の fsPath は小文字で返す。1.1.1）", () => {
    expect(pathForClipboard("c:\\Users\\a\\.aiwriter\\reports\\NAI-20261128-ab12.md")).toBe("C:\\Users\\a\\.aiwriter\\reports\\NAI-20261128-ab12.md");
    expect(pathForClipboard("D:\\作品\\x.md")).toBe("D:\\作品\\x.md");
    expect(pathForClipboard("/Users/a/.aiwriter/reports/x.md")).toBe("/Users/a/.aiwriter/reports/x.md");
    expect(pathForClipboard("\\\\server\\share\\x.md")).toBe("\\\\server\\share\\x.md");
  });
});
