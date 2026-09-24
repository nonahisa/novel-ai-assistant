import * as vscode from "vscode";
import * as path from "./paths";
import { AIWRITER_DIR, WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import { atomicWriteFile } from "./atomicWrite";
import {
  PENDING_DIR,
  buildPendingPayload,
  pendingFileName,
  // `pendingSourceLabel` はこの中では使わないので、下の再輸出だけで渡す
  readSource,
  type PendingUpdateKind,
  type PendingUpdateSource,
} from "./pendingUpdateFormat";
// **1件の読み方と並べ方は `pendingReview.ts` が持つ**（0.85.1）。MCP の
// `pending.list` も同じものを通るので、ここに写しを置かない
import {
  comparePendingCharacterUpdates,
  readPendingCharacterFile,
  type PendingUpdate,
} from "./pendingReview";

/**
 * 抽出で作られた「既存人物の更新案」の置き場。
 *
 * このプロジェクトは既存ファイルを上書きしない（`atomicWrite` を参照）。
 * そのため抽出しても既存人物には反映されず、以前は毎回失敗として
 * 回復ディレクトリに提案ファイルが溜まるだけだった。
 *
 * 更新案をここへ貯めておき、作者が内容を見て承認したときにだけ反映する。
 * 新規人物の承認制と同じ考え方で、AIの判断を黙って原稿へ入れない。
 *
 * `.aiwriter` の下に置くのは、作者が読む「設定」フォルダーを
 * 未確定のファイルで散らかさないため。
 *
 * ---
 *
 * **形そのものは `pendingUpdateFormat.ts` が持つ**（0.66.3）。
 * 外から呼ぶ束（MCPサーバー。設計書6.87.16 の `settings.propose`）が
 * 同じ形のファイルを置くのに、このファイルは `vscode` を import している
 * ので使えない。**写しを作らずに済ませる**ため、純粋な部分を切り出して
 * ここから再輸出している（`export { X } from` だけではこの中で `X` を
 * 使えないので、`import` を併記する）。
 */

export {
  PENDING_DIR,
  buildPendingPayload,
  pendingFileName,
  pendingSourceLabel,
  readKind,
  readReason,
  readSource,
  unwrapPendingCharacter,
  PENDING_CREATION_ID,
} from "./pendingUpdateFormat";
export type {
  PendingUpdateKind,
  PendingUpdateSource,
  PendingPayload,
} from "./pendingUpdateFormat";

/** 1件の形。定義は `pendingReview.ts`（MCP の束からも読むため、`vscode` を持たない側に置く） */
export type { PendingUpdate } from "./pendingReview";

/**
 * 新規案のIDは仮である（`PENDING_CREATION_ID`）。`parseCharacter` が
 * IDの形（`char_数字`）を確かめるので空にはできないが、**その番号のまま
 * 台帳へ入れてはいけない**——`applyPendingUpdates` が承認のときに採り直す。
 */

export class PendingUpdateStore {
  constructor(private readonly work: WorkEntry) {}

  private get directory(): string {
    return path.join(this.work.folderPath, AIWRITER_DIR, PENDING_DIR);
  }

  /**
   * 更新案を積む。
   *
   * @param options.source 出どころ。**省略したときは、その人物の
   *   既にある更新案から引き継ぐ。** 話数の付け替え（`episodeLedgers`）は
   *   中身だけを直して積み直すので、ここで落とすと「プロットから」の
   *   印が黙って消える
   * @param options.kind 新規案なら `"creation"`。**ファイル名を名前で作る**
   *   ——新規案のIDは仮なので、IDで名付けると別の名前の案どうしが
   *   同じファイルを取り合って、先に積んだ案が黙って消える
   */
  async stage(
    characters: Character[],
    options: { source?: PendingUpdateSource; kind?: PendingUpdateKind } = {}
  ): Promise<void> {
    if (characters.length === 0) return;
    await vscode.workspace.fs.createDirectory(
      path.toUri(this.directory)
    );

    for (const character of characters) {
      const target = path.join(
        this.directory,
        pendingFileName(character, options.kind)
      );
      const source = options.source ?? (await this.sourceOf(target));
      const payload = buildPendingPayload(character, {
        kind: options.kind,
        source,
      });
      const body = `${JSON.stringify(payload, null, 2)}\n`;
      // 保留ファイルは作者の原稿ではないので、上書きしてよい。
      // 同じ人物の更新案が2つ並んでも作者が困るだけ
      await atomicWriteFile(target, new TextEncoder().encode(body));
    }
  }

  /** 既にある更新案の出どころ。無ければ undefined（読めなくても同じ） */
  private async sourceOf(
    filePath: string
  ): Promise<PendingUpdateSource | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath));
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return readSource(parsed);
    } catch {
      // 無い・壊れているときは引き継ぐものが無いだけ。積むこと自体は続ける
      return undefined;
    }
  }

  /** 保留中の更新案を読む。壊れたものは読み飛ばして報告する */
  async loadAll(): Promise<{
    updates: PendingUpdate[];
    errors: Array<{ file: string; message: string }>;
  }> {
    const updates: PendingUpdate[] = [];
    const errors: Array<{ file: string; message: string }> = [];

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        path.toUri(this.directory)
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return { updates, errors };
      }
      throw error;
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
      const filePath = path.join(this.directory, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(
          path.toUri(filePath)
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        updates.push(readPendingCharacterFile(parsed, filePath));
      } catch (error) {
        errors.push({
          file: name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    updates.sort(comparePendingCharacterUpdates);
    return { updates, errors };
  }

  /** 反映済み・破棄した更新案を片付ける */
  async discard(filePath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(path.toUri(filePath));
    } catch {
      // 消せなくても実害はない。次回の一覧に残るだけ
    }
  }

  async count(): Promise<number> {
    return (await this.loadAll()).updates.length;
  }
}
