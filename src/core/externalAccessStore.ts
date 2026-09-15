import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import {
  EXTERNAL_ACCESS_DIRECTORY,
  EXTERNAL_ACCESS_FILE,
  parseExternalAccessLog,
  type ExternalAccessEntry,
} from "./externalAccessLog";

/**
 * 外部AIが作品を触った記録を、拡張機能から読む（設計書6.87.9）。
 *
 * **読むだけ。** 書くのはMCPサーバーの側（`mcp/tools/accessLog.ts`）で、
 * 拡張機能は書かない。書き手を1つに絞ってあるので、同じファイルへの
 * 追記が拡張機能とMCPで競合することがない。
 *
 * **消す口は作らない。** 履歴を後から直せると、履歴の意味が無くなる
 * （編集履歴と同じ）。溜まりすぎたときに作者が手で消すのは自由である。
 */
export class ExternalAccessLog {
  constructor(private readonly work: WorkEntry) {}

  private get filePath(): string {
    return path.join(
      workPaths(this.work).aiwriter,
      EXTERNAL_ACCESS_DIRECTORY,
      EXTERNAL_ACCESS_FILE
    );
  }

  /** 全部読む。**新しいものが先**に並ぶ。無ければ空 */
  async load(): Promise<ExternalAccessEntry[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath)
      );
      return parseExternalAccessLog(new TextDecoder().decode(bytes));
    } catch {
      // まだ一度も外から触られていなければ、ファイルは無い
      return [];
    }
  }
}
