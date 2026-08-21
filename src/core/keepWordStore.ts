import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import {
  emptyKeepWordSet,
  KEEP_WORD_SCHEMA_VERSION,
  parseKeepWordSet,
  validateKeepWord,
  type KeepWord,
  type KeepWordSet,
} from "../models/keepWord";
import { atomicWriteFile, createManagedRecoveryPath } from "./atomicWrite";

/**
 * 「直さない語」の保存先。
 *
 * 作品ごとに1ファイル（`設定/keep_words.json`）。`custom_fields.json` と
 * 同じ考えで、**作者が読んで手で直せる場所**に置く。件数はたかだか数十なので
 * 分割しない。
 */

export const KEEP_WORDS_FILE = "keep_words.json";

export class KeepWordStoreError extends Error {
  constructor(message: string, readonly recoveryPaths: string[] = []) {
    super(message);
    this.name = "KeepWordStoreError";
  }
}

export class KeepWordStore {
  constructor(private readonly work: WorkEntry) {}

  private async filePath(): Promise<string> {
    const config = await readWorkConfig(this.work);
    return path.join(workPaths(this.work, config).settings, KEEP_WORDS_FILE);
  }

  /** 読み込む。ファイルが無ければ「語なし」を返す */
  async load(): Promise<KeepWordSet> {
    const target = await this.filePath();
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return emptyKeepWordSet();
      }
      throw error;
    }

    try {
      return parseKeepWordSet(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      throw new KeepWordStoreError(
        `${KEEP_WORDS_FILE} を読めませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`,
        [target]
      );
    }
  }

  /**
   * 読めなければ空として扱う。
   *
   * **検知の途中で使う場面はこちら。** 守る語が読めないことを理由に
   * 誤字脱字の検知そのものを止めると、作者は何が起きたか分からない。
   * 守れないぶんは指摘が増えるだけで、原稿は壊れない。
   */
  async loadWords(): Promise<KeepWord[]> {
    try {
      return (await this.load()).words;
    } catch {
      return [];
    }
  }

  /**
   * 語を足す。既にあれば何もしない。
   *
   * @returns 足したなら true、既にあった・登録できない形なら false
   */
  async add(word: string, note = ""): Promise<boolean> {
    if (validateKeepWord(word)) return false;
    const body = word.trim();
    const set = await this.load();
    if (set.words.some((entry) => entry.word === body)) return false;

    set.words.push({
      word: body,
      note,
      // 時刻は要らない。作者が見直すのは「いつ頃足したか」だけである
      addedAt: new Date().toISOString().slice(0, 10),
    });
    await this.save(set);
    return true;
  }

  /** 語を消す。無ければ何もしない */
  async remove(word: string): Promise<boolean> {
    const set = await this.load();
    const before = set.words.length;
    set.words = set.words.filter((entry) => entry.word !== word);
    if (set.words.length === before) return false;
    await this.save(set);
    return true;
  }

  /**
   * 保存する。
   *
   * **既存ファイルは上書きできない**（`atomicWrite` を参照）ので、
   * 元ファイルを回復先へ退避してから新規作成する。
   */
  async save(set: KeepWordSet): Promise<void> {
    const target = await this.filePath();
    const body = JSON.stringify(
      { schemaVersion: KEEP_WORD_SCHEMA_VERSION, words: set.words },
      null,
      2
    );
    const bytes = new TextEncoder().encode(`${body}\n`);

    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(target))
    );

    let recoveryPath: string | undefined;
    if (await this.exists(target)) {
      try {
        recoveryPath = await createManagedRecoveryPath(target);
        await vscode.workspace.fs.rename(
          path.toUri(target),
          path.toUri(recoveryPath),
          { overwrite: false }
        );
      } catch (error) {
        throw new KeepWordStoreError(
          `${KEEP_WORDS_FILE} を退避できませんでした: ${
            error instanceof Error ? error.message : String(error)
          }`,
          [target]
        );
      }
    }

    try {
      await atomicWriteFile(target, bytes, { mode: "create" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new KeepWordStoreError(
        recoveryPath
          ? `${KEEP_WORDS_FILE} を保存できませんでした: ${detail} 元の内容は「${recoveryPath}」にあります。手動で戻してください。`
          : `${KEEP_WORDS_FILE} を保存できませんでした: ${detail}`,
        recoveryPath ? [recoveryPath] : []
      );
    }
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(path.toUri(target));
      return true;
    } catch {
      return false;
    }
  }
}
