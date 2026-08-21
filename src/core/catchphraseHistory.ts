import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { atomicWriteFile } from "./atomicWrite";

/**
 * 出したが採用されなかったキャッチコピーの履歴。
 *
 * 再生成のたびに同じ案が出てくると、作者は同じ判断を何度もさせられる。
 * 却下した案を渡して避けさせる。
 *
 * 置き場所は `.aiwriter/cache/`。**作品の内容ではない**ので設定資料には置かず、
 * Gitでも同期しない（キャッシュと同じ扱い）。消えても作り直せる。
 */

const HISTORY_FILE = "catchphrases.json";
/** 覚えておく件数。増やしすぎるとプロンプトが膨らむ */
const MAX_HISTORY = 30;

export class CatchphraseHistory {
  constructor(private readonly work: WorkEntry) {}

  private filePath(): string {
    return path.join(workPaths(this.work).aiwriter, "cache", HISTORY_FILE);
  }

  /** 読めなければ空として扱う。履歴は無くても機能が成り立つ */
  async load(): Promise<string[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath())
      );
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      return [];
    }
  }

  /** 却下した案を足す。保存に失敗しても機能を止めない */
  async add(texts: string[]): Promise<void> {
    const existing = await this.load();
    const merged = [...new Set([...existing, ...texts.map((t) => t.trim())])]
      .filter(Boolean)
      .slice(-MAX_HISTORY);

    const target = this.filePath();
    try {
      await vscode.workspace.fs.createDirectory(
        path.toUri(path.dirname(target))
      );
      await atomicWriteFile(
        target,
        new TextEncoder().encode(`${JSON.stringify(merged, null, 2)}\n`)
      );
    } catch {
      // 履歴が残らないだけで、次の生成は動く
    }
  }
}
