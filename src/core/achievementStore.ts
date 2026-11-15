import * as path from "./paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { workPaths } from "./workRegistry";
import {
  detectExternalChange,
  externalChangeMessage,
  snapshotOf,
  type ReadSnapshot,
} from "./readWriteGuard";
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
 * 読めないまま書けば、残っていた達成の印が消える。書く直前には読んだときの
 * 中身と照合する（`readWriteGuard.ts`。別の窓が先に書いた達成を消さない）。
 */

const ACHIEVEMENTS_FILE = "achievements.json";

export class AchievementStoreError extends Error {
  constructor(message: string, readonly kind?: "modified_externally") {
    super(message);
    this.name = "AchievementStoreError";
  }
}

export class AchievementStore {
  /** 読んだときの控え（`readWriteGuard.ts`）。書く直前の照合に使う */
  private snapshot: ReadSnapshot;

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
    // 読めなかったときに前の控えが残ると、読めなかったものを上書きしてしまう
    this.snapshot = undefined;
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(path.toUri(this.file()));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        this.snapshot = null;
        return [];
      }
      throw error;
    }
    const parsed = parseAchievementLog(JSON.parse(new TextDecoder().decode(bytes)));
    this.snapshot = snapshotOf(bytes);
    return parsed;
  }

  /**
   * 達成を書き足す。**読めない記録には書かない**（`load` の例外をそのまま投げる）。
   *
   * 読んでから書くまでに外（別の窓・同期）で記録が書き換わっていたら、**1回だけ
   * 読み直して足し直す**。足す達成は今の中身に依らないので、読み直せば外の記録も
   * こちらの達成も両方残る。2回目も違えば書かずに止める（呼び手は祝わずに記録へ残し、
   * 次の保存で改めて足し直す。`features/celebrations.ts`）。
   */
  async append(added: readonly Achievement[]): Promise<void> {
    if (added.length === 0) return;
    for (let attempt = 0; ; attempt++) {
      const current = await this.load();
      const next = appendAchievements(current, added);
      await vscode.workspace.fs.createDirectory(
        path.toUri(path.dirname(this.file()))
      );
      const body = {
        schemaVersion: ACHIEVEMENT_LOG_SCHEMA_VERSION,
        achievements: next,
      };
      const bytes = new TextEncoder().encode(`${JSON.stringify(body, null, 2)}\n`);
      const change = await detectExternalChange(this.file(), this.snapshot);
      if (change) {
        if (attempt === 0) continue;
        throw new AchievementStoreError(
          externalChangeMessage({
            label: "作品の達成の記録",
            fileLabel: `.aiwriter/${ACHIEVEMENTS_FILE}`,
            change,
          }),
          "modified_externally"
        );
      }
      await atomicWriteFile(this.file(), bytes);
      this.snapshot = snapshotOf(bytes);
      return;
    }
  }
}
