import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { notifyWorkRecordWritten } from "./workRecordSignal";
import { runSerialized } from "./ledgerQueue";
import {
  HISTORY_DIRECTORY,
  HISTORY_FILE,
  pickIncomingEditorLines,
  sortNewestFirst,
  parseHistory,
  type EditHistoryEntry,
} from "./editHistoryFormat";

// 読み方は VS Code に依存しないファイルへ切り出した（MCP の読む口と共有する）
export {
  dedupeHistory,
  historyDisplayName,
  parseHistory,
  sortNewestFirst,
  type EditHistoryEntry,
} from "./editHistoryFormat";

/**
 * 編集履歴（設計書5.6）。
 *
 * **既存の操作ログ（`.aiwriter/logs/ai_actions.log`）とは別に要る。**
 * あちらは `.gitignore` で同期から外れており（`workRegistry.ts`）、
 * **作者には編集部の操作が永久に届かない。**
 *
 * ここは `.aiwriter/history/edits.jsonl` に置く。`.aiwriter/` のうち
 * 除外されているのは `cache/` と `logs/` だけなので、**同期される。**
 *
 * **1行1件の追記だけにする。** 理由は2つある。
 *
 * 1. **競合しにくい。** 作者と編集部が同じ日に別々の操作をしても、
 *    追記どうしなら git がそのまま繋げられることが多い
 * 2. **競合しても復旧できる。** 行が混ざっただけなので、
 *    両方を残せば正しい履歴になる。並べ替えは読むときに行う
 *
 * **書き換えない・消さない。** 履歴を後から直せると、履歴の意味が無くなる。
 */

export class EditHistory {
  constructor(private readonly work: WorkEntry) {}

  private get filePath(): string {
    return path.join(
      workPaths(this.work).aiwriter,
      HISTORY_DIRECTORY,
      HISTORY_FILE
    );
  }

  /**
   * 1件書き足す。
   *
   * **失敗しても呼び出し側を止めない。** 履歴が残らないのは困るが、
   * そのために本来の操作（誤字の適用など）を失敗させるのは本末転倒である。
   */
  async append(entry: EditHistoryEntry): Promise<void> {
    // **取り込み（`mergeIncomingEditorLines`）と同じ鎖に通す。** どちらも「読む → 足す →
    // 書き戻す」なので、重なると後から書いたほうが先の行を巻き戻して消す
    await runSerialized(this.filePath, () => this.appendNow(entry));
  }

  /**
   * 編集用の写しから届いた編集履歴のうち、編集者の行だけを足す（設計書5.7.5.9。0.138.0）。
   *
   * 選び方は `pickIncomingEditorLines`（同じ行は二度入れない・取り込んだ時点の
   * GitHub のユーザー名を書き写す）。**今ある行は書き換えない。後ろへ足すだけ。**
   * 足した行数を返す。
   */
  async mergeIncomingEditorLines(
    incoming: string,
    editorLogin: string | undefined
  ): Promise<number> {
    const target = this.filePath;
    return runSerialized(target, async () => {
      const uri = path.toUri(target);
      let existing: Uint8Array = new Uint8Array();
      try {
        existing = await vscode.workspace.fs.readFile(uri);
      } catch {
        // まだ無い
      }
      const existingText = new TextDecoder().decode(existing);
      const lines = pickIncomingEditorLines(existingText, incoming, editorLogin);
      if (lines.length === 0) return 0;
      // 最後の行が改行で終わっていなければ、つなげる前に改行を補う（行がくっつくと両方読めない）
      const lead = existingText.length > 0 && !existingText.endsWith("\n") ? "\n" : "";
      const added = new TextEncoder().encode(lead + lines.join("\n") + "\n");
      const merged = new Uint8Array(existing.byteLength + added.byteLength);
      merged.set(existing, 0);
      merged.set(added, existing.byteLength);
      await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
      await vscode.workspace.fs.writeFile(uri, merged);
      notifyWorkRecordWritten(target);
      return lines.length;
    });
  }

  private async appendNow(entry: EditHistoryEntry): Promise<void> {
    const target = this.filePath;
    const line = JSON.stringify(entry) + "\n";
    try {
      await vscode.workspace.fs.createDirectory(
        path.toUri(path.dirname(target))
      );
      const uri = path.toUri(target);
      let existing: Uint8Array;
      try {
        existing = await vscode.workspace.fs.readFile(uri);
      } catch {
        existing = new Uint8Array();
      }
      const added = new TextEncoder().encode(line);
      const merged = new Uint8Array(existing.byteLength + added.byteLength);
      merged.set(existing, 0);
      merged.set(added, existing.byteLength);
      await vscode.workspace.fs.writeFile(uri, merged);
      // タイムラインの欄に、増えた1行をすぐ出させる（保存の知らせは来ない）
      notifyWorkRecordWritten(target);
    } catch {
      // 履歴が残らないことより、操作が止まるほうが困る
    }
  }

  /** 全部読む。**新しいものが先**に並ぶ */
  async load(): Promise<EditHistoryEntry[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath)
      );
      return sortNewestFirst(parseHistory(new TextDecoder().decode(bytes)));
    } catch {
      return [];
    }
  }
}
