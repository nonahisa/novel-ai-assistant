import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import {
  CUSTOM_FIELD_SCHEMA_VERSION,
  emptyCustomFieldSet,
  parseCustomFieldSet,
  type CustomFieldDefinition,
  type CustomFieldSet,
} from "../models/customField";
import { atomicWriteFile, createManagedRecoveryPath } from "./atomicWrite";

/**
 * 作者が足した項目の定義の保存先。
 *
 * 作品ごとに1ファイル（`設定/custom_fields.json`）。
 * 人物設定と同じ `設定/` に置くのは、作者が中身を読める場所であり、
 * Gitでも共同作業者へ渡したい情報だからである。
 * `.aiwriter/` は拡張機能の管理領域なので、ここには置かない。
 *
 * 項目数はたかだか20件なので、1人1ファイルにしている人物設定と違い、
 * 分割しない。同時に別々の項目を足して競合する状況は考えにくい。
 */

export const CUSTOM_FIELDS_FILE = "custom_fields.json";

export class CustomFieldStoreError extends Error {
  constructor(message: string, readonly recoveryPaths: string[] = []) {
    super(message);
    this.name = "CustomFieldStoreError";
  }
}

export class CustomFieldStore {
  constructor(private readonly work: WorkEntry) {}

  private async filePath(): Promise<string> {
    const config = await readWorkConfig(this.work);
    return path.join(workPaths(this.work, config).settings, CUSTOM_FIELDS_FILE);
  }

  /**
   * 定義を読み込む。ファイルが無ければ「項目なし」を返す。
   *
   * **壊れていたら例外を投げる。** 空として扱って上書きすると、
   * 作者が手で書き足した定義がまるごと消える。
   */
  async load(): Promise<CustomFieldSet> {
    const target = await this.filePath();
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return emptyCustomFieldSet();
      }
      throw error;
    }

    try {
      return parseCustomFieldSet(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      throw new CustomFieldStoreError(
        `${CUSTOM_FIELDS_FILE} を読めませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`,
        [target]
      );
    }
  }

  /** 読めなければ空として扱う。表示だけの用途で、失敗させたくない場面で使う */
  async loadFields(): Promise<CustomFieldDefinition[]> {
    try {
      return (await this.load()).fields;
    } catch {
      return [];
    }
  }

  /**
   * 定義を保存する。
   *
   * 既存ファイルは上書きできない（`atomicWrite` を参照）ので、
   * **元ファイルを回復先へ退避してから新規作成する。**
   * 人物設定の `update()` と同じ手順。
   */
  async save(set: CustomFieldSet): Promise<void> {
    const target = await this.filePath();
    const body = JSON.stringify(
      { schemaVersion: CUSTOM_FIELD_SCHEMA_VERSION, fields: set.fields },
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
        throw new CustomFieldStoreError(
          `${CUSTOM_FIELDS_FILE} を退避できませんでした: ${
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
      throw new CustomFieldStoreError(
        recoveryPath
          ? `${CUSTOM_FIELDS_FILE} を保存できませんでした: ${detail} 元の内容は「${recoveryPath}」にあります。手動で戻してください。`
          : `${CUSTOM_FIELDS_FILE} を保存できませんでした: ${detail}`,
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
