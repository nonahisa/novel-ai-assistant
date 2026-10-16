import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { atomicWriteFile } from "./atomicWrite";
import {
  ANNOUNCEMENT_HISTORY_SUBPATH,
  formatAnnouncementHistory,
  mergeAnnouncementHistory,
  parseAnnouncementHistory,
} from "./announceConfig";

/**
 * これまでに作った更新告知（X用の本文）の履歴。
 *
 * 話が変わっても同じ言い回し（「ついに動き出します」）ばかりが出ると、
 * 並べて読む読者には手抜きに見える。前に出したものを渡して避けさせる。
 *
 * **採用したかどうかに関わらず足す。** 目的は「同じ言い回しを避ける」
 * ことなので、作者が貼らなかった案も、次の生成では避ける対象になる。
 * （キャッチコピーの履歴は「却下した案」を覚えるもので、狙いが違う）
 *
 * 置き場所は `.aiwriter/cache/`。**作品の内容ではない**ので設定資料には置かず、
 * Gitでも同期しない（キャッシュと同じ扱い）。消えても作り直せる。
 */

export class AnnouncementHistory {
  constructor(private readonly work: WorkEntry) {}

  private filePath(): string {
    // 置き場と読み方は `announceConfig.ts` が持つ（MCP の告知文も同じものを読む）
    return path.join(workPaths(this.work).aiwriter, ...ANNOUNCEMENT_HISTORY_SUBPATH);
  }

  /** 読めなければ空として扱う。履歴は無くても機能が成り立つ */
  async load(): Promise<string[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath())
      );
      return parseAnnouncementHistory(new TextDecoder().decode(bytes));
    } catch {
      return [];
    }
  }

  /** 出した告知を足す。保存に失敗しても機能を止めない */
  async add(texts: string[]): Promise<void> {
    const existing = await this.load();
    // 足し方（重ね落とし・件数）は MCP の告知文と同じ関数を通す（`announceConfig.ts`）
    const merged = mergeAnnouncementHistory(existing, texts);

    const target = this.filePath();
    try {
      await vscode.workspace.fs.createDirectory(
        path.toUri(path.dirname(target))
      );
      await atomicWriteFile(
        target,
        new TextEncoder().encode(formatAnnouncementHistory(merged))
      );
    } catch {
      // 履歴が残らないだけで、次の生成は動く
    }
  }
}
