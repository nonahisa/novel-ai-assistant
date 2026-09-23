import * as path from "./paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { workPaths } from "./workRegistry";
import {
  ACHIEVEMENT_LOG_SCHEMA_VERSION,
  appendAchievements,
  parseAchievementLog,
  type Achievement,
} from "./celebrations";

/**
 * 作品の目標の達成の記録（設計書6.3.8）。
 *
 * `.aiwriter/achievements.json` に置く。**作品の側に置く**のは、作品の文字量や
 * 締切の達成が**その作品についての事実**だからである。別の環境で同じ作品を
 * 書いても、同期された記録を見て二度は祝わない（端末の中に持つと、2台目で
 * もう一度風船が上がる）。
 *
 * 1日・1月の達成はここへは書かない。目標が全作品で共有の設定なので、
 * 作品のどれか1つに置く理由が無い（`features/celebrations.ts` が globalState に持つ）。
 *
 * **環境ごとのファイルに分けない。** 書くのは達成した瞬間だけで（作品1本に数回）、
 * 執筆量の記録のように保存のたびに書くものではない。同時に2台で書き込む
 * 機会がほとんど無いので、`goals.json` と同じく1つのファイルにする。
 *
 * このファイルは拡張機能だけが書く。`atomicWriteFile` を引数無しで呼ぶ
 * （執筆量の記録と同じ経路）。ただし**読めない記録は上書きしない**——
 * 読めないまま書けば、残っていた達成の印が消える。
 */

const ACHIEVEMENTS_FILE = "achievements.json";

export class AchievementStore {
  constructor(private readonly work: WorkEntry) {}

  private file(): string {
    return path.join(workPaths(this.work).aiwriter, ACHIEVEMENTS_FILE);
  }

  /**
   * 記録を読む。無ければ空。
   *
   * @throws 壊れていたとき（競合マーカーなど）。無いことは失敗ではない
   */
  async load(): Promise<Achievement[]> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(path.toUri(this.file()));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return [];
      }
      throw error;
    }
    return parseAchievementLog(JSON.parse(new TextDecoder().decode(bytes)));
  }

  /**
   * 達成を書き足す。**読めない記録には書かない**（`load` の例外をそのまま投げる）。
   */
  async append(added: readonly Achievement[]): Promise<void> {
    if (added.length === 0) return;
    const current = await this.load();
    const next = appendAchievements(current, added);
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(this.file()))
    );
    const body = {
      schemaVersion: ACHIEVEMENT_LOG_SCHEMA_VERSION,
      achievements: next,
    };
    await atomicWriteFile(
      this.file(),
      new TextEncoder().encode(`${JSON.stringify(body, null, 2)}\n`)
    );
  }
}
