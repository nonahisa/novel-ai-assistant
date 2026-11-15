/**
 * 保存の直前の置き換えが、**保存に間に合わなかった**とき（画面の自動テスト、設計書5.4.2・6.113。1.0.5）。
 *
 * ノートPC（2026-11-15）：42万字の Shift_JIS の合本で「〜」を打って Ctrl+S すると、ビルド直後の重い時の
 * 1回目だけ、ファイルの末尾が「?」（0x3f）で書かれ、未保存の印が残った。VS Code の画面の側は、保存の
 * 直前の受け口の答えを 1.75 秒しか待たず、過ぎると書き換え無しで保存する（本体のコード）。
 *
 * ここでは、遅い機械の代わりに**補助の拡張機能**で拡張機能ホストを2.5秒ふさぐ。補助は「*」で起きるので、
 * 製品（onStartupFinished）より先に保存の受け口を並べる。命令で仕掛けると、次の保存の受け口で同期のまま
 * 2.5秒待つ——その間に画面の側の1.75秒が過ぎ、製品の受け口はそのあとに呼ばれる（ノートPCと同じ順）。
 *
 * 見張ること：
 * 1. ファイルは最後に「～」（81 60）で書かれ、「?」（3f）が残らない
 * 2. タブに未保存の印が残らない
 * 3. 作品のログに「保存し直しました」が残る
 *
 * 製品にテスト専用の口は足していない。**AI は呼ばない。**
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import iconv = require("iconv-lite");
import { expect, test } from "vitest";
import { runCommand } from "./support/quickInput";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { focusTextEditor, quickOpen, tabIsDirty } from "./support/workbenchDom";
import { EDITOR_BOTTOM_PRESS } from "./support/keys";

const EPISODE = "001_駅.txt";
const BODY = "終電を逃した駅のホーム。\n雨の音だけが残っていた。\n";
const ARM_TITLE = "E2E: 次の保存で拡張機能ホストをふさぐ";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

/** 次の保存の受け口で、拡張機能ホストを同期のまま2.5秒ふさぐ補助の拡張機能 */
async function slowSaveExtension(root: string): Promise<string[]> {
  const folder = path.join(root, "補助の拡張機能", "e2e-slow-save");
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "package.json"),
    JSON.stringify(
      {
        name: "e2e-slow-save",
        publisher: "e2e",
        displayName: "保存の受け口を遅らせる補助（画面の自動テスト用）",
        version: "0.0.1",
        engines: { vscode: "^1.80.0" },
        main: "./extension.js",
        activationEvents: ["*"],
        contributes: { commands: [{ command: "e2eSlowSave.arm", title: ARM_TITLE }] },
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(folder, "extension.js"),
    [
      'const vscode = require("vscode");',
      'const fs = require("fs");',
      'const path = require("path");',
      "let armed = false;",
      "exports.activate = (context) => {",
      "  context.subscriptions.push(",
      // 仕掛けたことを印のファイルで知らせる（テストはこれを待ってから Ctrl+S を押す。重いとき、
      // パレットの命令が拡張機能の側へ届く前に保存が走ると、ふさがずに保存されて揺れた）
      '    vscode.commands.registerCommand("e2eSlowSave.arm", () => { armed = true; fs.writeFileSync(path.join(context.extensionPath, "armed.flag"), "1"); }),',
      "    vscode.workspace.onWillSaveTextDocument(() => {",
      "      if (!armed) return;",
      "      armed = false;",
      "      const until = Date.now() + 2500;",
      "      while (Date.now() < until) { /* 遅い機械の代わりに、拡張機能ホストを同期のままふさぐ */ }",
      "    })",
      "  );",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  return [folder];
}

test("保存の直前の置き換えが保存に間に合わなくても、ファイルは最後に「～」（81 60）で書かれ、「?」も未保存の印も残らない（1.0.5）", async () => {
  await withVsCode(
    "Shift_JIS 保存に間に合わない",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page, manuscriptFolder, workFolder } = session;
      const file = path.join(manuscriptFolder, EPISODE);
      const original = iconv.encode(BODY, "shift_jis").length;
      await quickOpen(page, EPISODE);
      await runCommand(page, ARM_TITLE);
      const armedFlag = path.join(session.root, "補助の拡張機能", "e2e-slow-save", "armed.flag");
      await waitUntil(async () => (await stat(armedFlag).catch(() => undefined)) !== undefined, "補助の拡張機能が次の保存を仕掛けた", 15_000);
      await focusTextEditor(page);
      await page.keyboard.press(EDITOR_BOTTOM_PRESS);
      await page.keyboard.insertText("〜");
      await page.keyboard.press("ControlOrMeta+KeyS");

      let bytes = new Uint8Array();
      let dirty = true;
      await waitUntil(
        async () => {
          bytes = await readFile(file).catch(() => bytes);
          dirty = await tabIsDirty(page, EPISODE);
          const tail = Array.from(bytes.slice(original));
          return tail.length === 2 && tail[0] === 0x81 && tail[1] === 0x60 && !dirty;
        },
        "ファイルの末尾が「～」（81 60）になり、未保存の印が消える",
        20_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（末尾：${hex(bytes.slice(original))}／未保存の印：${dirty}）`);
      });
      expect(bytes.includes(0x3f), `ファイル：${hex(bytes)}`).toBe(false);

      // ログは書き込みが遅れることがあるので、出るまで待って読む
      let log = "";
      await waitUntil(
        async () => (log = await readFile(path.join(workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "")).includes("保存し直しました"),
        "作品のログに保存し直したことが残る",
        15_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（ログの末尾：${JSON.stringify(log.slice(-400))}）`);
      });
    },
    {
      settings: { "files.encoding": "shiftjis", "workbench.editorAssociations": { "*.txt": "default", "*.md": "default" } },
      extraExtensions: slowSaveExtension,
      prepareWork: async ({ manuscriptFolder }) => {
        await writeFile(path.join(manuscriptFolder, EPISODE), iconv.encode(BODY, "shift_jis"));
      },
    }
  );
}, 180_000);
