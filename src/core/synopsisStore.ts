import * as vscode from "vscode";
import * as path from "./paths";
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
import { decodeByteFallback } from "./byteFallback";
import {
  detectExternalChange,
  externalChangeMessage,
  keepUnsavedCopy,
  snapshotOf,
  type ReadSnapshot,
} from "./readWriteGuard";

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
  constructor(
    message: string,
    readonly recoveryPaths: string[] = [],
    readonly kind?: "modified_externally"
  ) {
    super(message);
    this.name = "SynopsisStoreError";
  }
}

export class SynopsisStore {
  /** 読んだときの控え（`readWriteGuard.ts`）。書く直前の照合に使う */
  private snapshot: ReadSnapshot;

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
    // 読めなかったときに前の控えが残ると、読めなかったものを上書きしてしまう
    this.snapshot = undefined;
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        this.snapshot = null;
        return emptySynopsisSet();
      }
      throw error;
    }

    let parsed: ChapterSynopsisSet;
    try {
      // 既に保存されてしまった文字化けをここで戻す。
      // 珍しい漢字が `<0xE5><0x9B><0xAE>`（＝囮）のまま入っていた作品がある。
      // 読むたびに戻せば、次に書き直したときに直った内容が保存される
      parsed = parseSynopsisSet(
        JSON.parse(decodeByteFallback(new TextDecoder().decode(bytes)))
      );
    } catch (error) {
      throw new SynopsisStoreError(
        `${CHAPTER_SYNOPSES_FILE} を読めませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`,
        [target]
      );
    }
    // 片付けの保存（下）より前に覚える。後にすると、片付けが照合で必ず止まる
    this.snapshot = snapshotOf(bytes);

    // ファイル名込みのキーだった時期の重複が残っていれば、読み込むたびに片付ける
    const deduped = dedupeSynopsisEpisodes(parsed.episodes);
    if (deduped.removed === 0) return parsed;

    const cleaned: ChapterSynopsisSet = { ...parsed, episodes: deduped.episodes };
    try {
      // 片付けは次に読んだときにもう一度できるので、止まっても回復先へは控えない
      await this.write(cleaned, false);
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
   *
   * **退避の前に、読んだときから外で変わっていないかを照合する**（`readWriteGuard.ts`）。
   * 各話あらすじはAIを呼んで作るので（数分かかることもある）、その間に同期や手で
   * 書き換わることがある。違えば書かずに止め、作った中身を回復先へ控える
   * （AIの呼び出しを無駄にしない）。
   */
  async save(set: ChapterSynopsisSet): Promise<void> {
    await this.write(set, true);
  }

  private async write(set: ChapterSynopsisSet, keepCopy: boolean): Promise<void> {
    const target = await this.filePath();
    const body = JSON.stringify(
      { schemaVersion: SYNOPSIS_SCHEMA_VERSION, episodes: set.episodes },
      null,
      2
    );
    const bytes = new TextEncoder().encode(`${body}\n`);

    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(target))
    );

    const change = await detectExternalChange(target, this.snapshot);
    if (change) {
      const unsavedCopy = keepCopy ? await keepUnsavedCopy(target, bytes) : undefined;
      throw new SynopsisStoreError(
        externalChangeMessage({
          label: "各話あらすじ",
          fileLabel: `設定/${CHAPTER_SYNOPSES_FILE}`,
          change,
          unsavedCopy,
        }),
        unsavedCopy ? [target, unsavedCopy] : [target],
        "modified_externally"
      );
    }

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
    // 自分で書いた中身で覚え直す。名前の追随→AIのあとの保存のように、同じ口で続けて
    // 保存する呼び手がある（`generateSynopses.ts`）
    this.snapshot = snapshotOf(bytes);
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(path.toUri(filePath));
      return true;
    } catch {
      return false;
    }
  }
}
