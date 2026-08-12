import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import {
  dedupeSynopsisEpisodes,
  SYNOPSIS_SCHEMA_VERSION,
  emptySynopsisSet,
  parseSynopsisSet,
  type ChapterSynopsisSet,
} from "../models/synopsis";
import { atomicWriteFile, createManagedRecoveryPath } from "./atomicWrite";

/**
 * 各話あらすじの保存先。
 *
 * 作品ごとに1ファイル（`設定/chapter_synopses.json`）。
 * `設定/` に置くのは、作者が読み書きできる場所であり、
 * 投稿サイトへ貼るときにそのまま使う情報だからである。
 *
 * 1話1ファイルにしないのは、あらすじが短く、話をまたいで
 * 通して読むほうが多いためである（人物設定とは使い方が違う）。
 */

export const CHAPTER_SYNOPSES_FILE = "chapter_synopses.json";

export class SynopsisStoreError extends Error {
  constructor(message: string, readonly recoveryPaths: string[] = []) {
    super(message);
    this.name = "SynopsisStoreError";
  }
}

export class SynopsisStore {
  constructor(private readonly work: WorkEntry) {}

  private async filePath(): Promise<string> {
    const config = await readWorkConfig(this.work);
    return path.join(
      workPaths(this.work, config).settings,
      CHAPTER_SYNOPSES_FILE
    );
  }

  /**
   * 読み込む。ファイルが無ければ空を返す。
   *
   * **壊れていたら例外を投げる。** 空として扱って保存すると、
   * 作者が書き直したあらすじがまるごと消える。
   */
  async load(): Promise<ChapterSynopsisSet> {
    const target = await this.filePath();
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return emptySynopsisSet();
      }
      throw error;
    }

    let parsed: ChapterSynopsisSet;
    try {
      parsed = parseSynopsisSet(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      throw new SynopsisStoreError(
        `${CHAPTER_SYNOPSES_FILE} を読めませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`,
        [target]
      );
    }

    // ファイル名込みのキーだった時期の重複が残っていれば、読み込むたびに片付ける
    const deduped = dedupeSynopsisEpisodes(parsed.episodes);
    if (deduped.removed === 0) return parsed;

    const cleaned: ChapterSynopsisSet = { ...parsed, episodes: deduped.episodes };
    try {
      await this.save(cleaned);
    } catch {
      // 保存できなくても、読み込み結果自体は重複無しで返せる
    }
    return cleaned;
  }

  /**
   * 保存する。
   *
   * 既存ファイルは上書きできない（`atomicWrite` を参照）ので、
   * **元ファイルを回復先へ退避してから新規作成する。**
   */
  async save(set: ChapterSynopsisSet): Promise<void> {
    const target = await this.filePath();
    const body = JSON.stringify(
      { schemaVersion: SYNOPSIS_SCHEMA_VERSION, episodes: set.episodes },
      null,
      2
    );
    const bytes = new TextEncoder().encode(`${body}\n`);

    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(target))
    );

    let recoveryPath: string | undefined;
    if (await this.exists(target)) {
      try {
        recoveryPath = await createManagedRecoveryPath(target);
        await vscode.workspace.fs.rename(
          vscode.Uri.file(target),
          vscode.Uri.file(recoveryPath),
          { overwrite: false }
        );
      } catch (error) {
        throw new SynopsisStoreError(
          `${CHAPTER_SYNOPSES_FILE} を退避できませんでした: ${
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
      throw new SynopsisStoreError(
        recoveryPath
          ? `${CHAPTER_SYNOPSES_FILE} を保存できませんでした: ${detail} 元の内容は「${recoveryPath}」にあります。手動で戻してください。`
          : `${CHAPTER_SYNOPSES_FILE} を保存できませんでした: ${detail}`,
        recoveryPath ? [recoveryPath] : []
      );
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch {
      return false;
    }
  }
}
