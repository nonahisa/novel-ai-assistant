/**
 * 設定資料（人物の記録）の見本を、製品が読む形で置く・設定資料パネルを探す（設計書6.113）。
 *
 * 人物は `models/character.ts` の `emptyCharacter` に中身を足した形で、
 * ファイル名は製品と同じ `characterFileName` で付ける。**AI は呼ばない。**
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { characterFileName, type Character } from "../../../src/models/character";
import { DEFAULT_SETTINGS_DIR } from "../../../src/models/types";
import type { E2ESession } from "./vscodeApp";

/** 作品の設定資料の置き場（登録で作られた `.aiwriter/config.json` の settingsDir） */
export async function settingsFolder(session: E2ESession): Promise<string> {
  const config = JSON.parse(
    await readFile(path.join(session.workFolder, ".aiwriter", "config.json"), "utf8")
  ) as { settingsDir?: string };
  return path.join(session.workFolder, config.settingsDir || "設定");
}

/** 人物の置き場（`設定/characters`） */
export async function charactersFolder(session: E2ESession): Promise<string> {
  return path.join(await settingsFolder(session), "characters");
}

/**
 * 起こす前（`LaunchOptions.prepareWork`）の人物の置き場。登録の前なので config.json はまだ無く、
 * 登録で書かれる既定の置き場（`DEFAULT_SETTINGS_DIR`）を使う
 */
export function defaultCharactersFolder(workFolder: string): string {
  return path.join(workFolder, DEFAULT_SETTINGS_DIR, "characters");
}

/** 人物の記録を、指定の置き場へ製品と同じファイル名で置く。置いた道を返す */
export async function writeCharactersTo(folder: string, characters: readonly Character[]): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const written: string[] = [];
  for (const character of characters) {
    const file = path.join(folder, characterFileName(character));
    await writeFile(file, JSON.stringify(character, null, 2), "utf8");
    written.push(file);
  }
  return written;
}

/** 設定資料パネルの面（「ルビを追加」のボタン `#apply-ruby` を持つ） */
export async function settingsPanelFrame(session: E2ESession): Promise<Frame | undefined> {
  for (const frame of session.page.frames()) {
    const has = await frame.evaluate(() => document.querySelector("#apply-ruby") !== null).catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 設定資料パネルの左の一覧に並んでいる行の字 */
export async function settingsListRows(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll("#list .item")).map((row) => (row as HTMLElement).innerText.trim())
  );
}
