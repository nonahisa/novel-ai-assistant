import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import {
  emptyTimeline,
  parseTimeline,
  TIMELINE_SCHEMA_VERSION,
  type Timeline,
} from "../models/timeline";
import { atomicWriteFile, createManagedRecoveryPath } from "./atomicWrite";

/**
 * 作中の時間（系統・時期・話との対応）の保存先。
 *
 * 作品ごとに1ファイル（`設定/timeline.json`）。
 * `設定/` に置くのは、作者が中身を読んで手で直せる場所であり、
 * Gitで共同作業者へも渡したい情報だからである
 * （`.aiwriter/` は拡張機能の管理領域なので置かない）。
 *
 * 追加項目の定義（`custom_fields.json`）と同じく分割しない。
 * 系統も時期もたかだか数十件で、別々の時期を同時に足して競合する状況は
 * 考えにくい。
 */

export const TIMELINE_FILE = "timeline.json";

export class TimelineStoreError extends Error {
  constructor(message: string, readonly recoveryPaths: string[] = []) {
    super(message);
    this.name = "TimelineStoreError";
  }
}

export class TimelineStore {
  constructor(private readonly work: WorkEntry) {}

  private async filePath(): Promise<string> {
    const config = await readWorkConfig(this.work);
    return path.join(workPaths(this.work, config).settings, TIMELINE_FILE);
  }

  /**
   * 読み込む。ファイルが無ければ「系統なし」を返す。
   *
   * 系統なしは「すべてが本編1本」を意味する（`isCanonicalEpisode` を参照）。
   * 時間を設定していない作品でも、これまでどおり動く。
   *
   * **壊れていたら例外を投げる。** 空として扱って上書きすると、
   * 作者が組み立てた年表がまるごと消える。
   */
  async load(): Promise<Timeline> {
    const target = await this.filePath();
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return emptyTimeline();
      }
      throw error;
    }

    try {
      return parseTimeline(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      throw new TimelineStoreError(
        `${TIMELINE_FILE} を読めませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`,
        [target]
      );
    }
  }

  /**
   * 読めなければ「系統なし」として扱う。
   *
   * 表示だけの用途で使う。**ただし、この既定はすべてを本編扱いにする。**
   * IF編を本編に混ぜたくない処理（人物一覧・年表・設定資料の書き出し）では
   * この関数を使わず `load()` の失敗を作者に見せること。
   */
  async loadOrEmpty(): Promise<Timeline> {
    try {
      return await this.load();
    } catch {
      return emptyTimeline();
    }
  }

  /**
   * 保存する。
   *
   * 既存ファイルは上書きできない（`atomicWrite` を参照）ので、
   * **元ファイルを回復先へ退避してから新規作成する。**
   * `CustomFieldStore.save()` と同じ手順。
   */
  async save(timeline: Timeline): Promise<void> {
    const target = await this.filePath();
    const body = JSON.stringify(
      {
        schemaVersion: TIMELINE_SCHEMA_VERSION,
        lines: timeline.lines,
        timepoints: timeline.timepoints,
        episodes: timeline.episodes,
      },
      null,
      2
    );
    const bytes = new TextEncoder().encode(`${body}\n`);

    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(target))
    );

    const existed = await this.exists(target);
    let recoveryPath: string | undefined;
    if (existed) {
      try {
        recoveryPath = await createManagedRecoveryPath(target);
        await vscode.workspace.fs.rename(
          vscode.Uri.file(target),
          vscode.Uri.file(recoveryPath),
          { overwrite: false }
        );
      } catch (error) {
        throw new TimelineStoreError(
          `${TIMELINE_FILE} を退避できませんでした: ${
            error instanceof Error ? error.message : String(error)
          }`,
          [target]
        );
      }
    }

    try {
      await atomicWriteFile(target, bytes, { mode: "create" });
    } catch (error) {
      // 退避したのに作成に失敗すると、正規パスにファイルが無い状態になる。
      // 中身は回復先にあるので、その場所を必ず伝える
      const detail = error instanceof Error ? error.message : String(error);
      throw new TimelineStoreError(
        recoveryPath
          ? `${TIMELINE_FILE} を保存できませんでした: ${detail} 元の内容は「${recoveryPath}」にあります。手動で戻してください。`
          : `${TIMELINE_FILE} を保存できませんでした: ${detail}`,
        recoveryPath ? [recoveryPath] : []
      );
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return false;
      }
      throw error;
    }
  }
}
