import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CharacterStore } from "../core/characterStore";
import { scanWork } from "../core/scanner";
import { scaffoldWorkFolder } from "../core/workRegistry";
import { emptyCharacter } from "../models/character";
import type { WorkEntry } from "../models/types";

const COMMANDS = [
  "novelai.addWork",
  "novelai.createWork",
  "novelai.removeWork",
  "novelai.refresh",
  "novelai.addEpisode",
  "novelai.openWorkFolder",
  "novelai.showWorkStats",
  "novelai.setupAI",
  "novelai.testAI",
  "novelai.extractCharacters",
];

export async function run(): Promise<void> {
  const failures: string[] = [];
  await runCase("拡張機能を起動し、全コマンドを登録する", failures, async () => {
    const extension = vscode.extensions.getExtension("local.novel-ai-assistant");
    assert.ok(extension, "拡張機能 local.novel-ai-assistant が見つかりません");
    await extension.activate();
    const registered = await vscode.commands.getCommands(true);
    for (const command of COMMANDS) {
      assert.ok(registered.includes(command), `${command} が登録されていません`);
    }
  });

  await runCase("作品を作成・走査し、既存フォルダを上書きしない", failures, async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "novel-ai-assistant-work-")
    );
    try {
      const workFolder = path.join(temporaryRoot, "テスト作品");
      await scaffoldWorkFolder(workFolder, "テスト作品");
      const configPath = path.join(workFolder, ".aiwriter", "config.json");
      const originalConfig = await fs.readFile(configPath, "utf8");

      await assert.rejects(
        scaffoldWorkFolder(workFolder, "上書きされてはいけない名前"),
        /すでに存在/
      );
      assert.equal(await fs.readFile(configPath, "utf8"), originalConfig);

      await fs.writeFile(
        path.join(workFolder, "本文", "001.txt"),
        "【タイトル】\n始まり\n\n【文字数】\n5文字\n\n【本文（1行）】\n本文です。",
        "utf8"
      );
      const work = makeWork(workFolder);
      const scanned = await scanWork(work);
      assert.equal(scanned.stats.fileCount, 1);
      assert.equal(scanned.episodes[0].metaTitle, "始まり");
      assert.equal(scanned.episodes[0].counts.net, 5);

      const character = emptyCharacter("char_001", "灯");
      character.authorNotes = "作者のメモ";
      const store = new CharacterStore(work);
      await store.save(character);
      const loaded = await store.loadAll();
      assert.equal(loaded.errors.length, 0);
      assert.equal(loaded.characters[0].authorNotes, "作者のメモ");
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  if (failures.length > 0) {
    throw new Error(`Integration tests failed:\n${failures.join("\n")}`);
  }
}

async function runCase(
  name: string,
  failures: string[],
  test: () => Promise<void>
): Promise<void> {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.push(`FAIL ${name}\n${detail}`);
  }
}

function makeWork(folderPath: string): WorkEntry {
  return {
    id: "work_integration",
    title: "テスト作品",
    folderPath,
    registeredAt: "2026-08-06T00:00:00.000Z",
  };
}
