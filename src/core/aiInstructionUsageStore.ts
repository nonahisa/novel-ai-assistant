import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import {
  AI_INSTRUCTION_USAGE_FILE,
  formatAiInstructionUsage,
  parseAiInstructionUsage,
  type AiInstructionUsage,
  type AiInstructionUsageRecord,
} from "./aiInstructionUsage";

/**
 * 「作品フォルダーを開いて使うか、開かずに使うか」の覚え書き
 *  （設計書6.87.14 の末尾）。
 *
 * **拡張機能だけが書く小さな控えである。** 作者が手で書くファイルでも、
 * MCP サーバーが読むファイルでもない——だから許可の印
 * （`external-access.json`）と同じく、素直に書き直す（退避は持たない）。
 * 中身は「どちらを選んだか」と「いつか」の2つだけで、失っても
 * 書き出しをやり直せば戻る。
 */
export class AiInstructionUsageStore {
  constructor(private readonly work: WorkEntry) {}

  private get filePath(): string {
    return path.join(workPaths(this.work).aiwriter, AI_INSTRUCTION_USAGE_FILE);
  }

  /** いまどちらを選んでいるか。**無い・読めないときは「選んでいない」** */
  async load(): Promise<AiInstructionUsageRecord | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath)
      );
      return parseAiInstructionUsage(new TextDecoder().decode(bytes));
    } catch {
      return undefined;
    }
  }

  async save(usage: AiInstructionUsage): Promise<AiInstructionUsageRecord> {
    const record: AiInstructionUsageRecord = {
      usage,
      decidedAt: new Date().toISOString(),
    };
    const target = this.filePath;
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    await vscode.workspace.fs.writeFile(
      path.toUri(target),
      new TextEncoder().encode(formatAiInstructionUsage(record))
    );
    return record;
  }
}
