import * as path from "path";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type {
  DeviceWritingStats,
  WritingMeasurement,
} from "../models/writingStats";
import { atomicWriteFile } from "./atomicWrite";
import { workPaths } from "./workRegistry";
import {
  emptyDeviceStats,
  parseDeviceWritingStats,
  recordMeasurement,
  rebaseline,
  shouldPersist,
  type RecordResult,
} from "./writingStats";

/**
 * 執筆量の保存先（設計書5.5.6）。
 *
 * **端末ごとに1ファイル、読むときに合算する。** 1つのファイルを全環境で
 * 共有すると、2台で書いた瞬間に必ず競合する。書き込むのは自分の端末の
 * ファイルだけなので、構造上競合しない。最終編集環境の記録
 * （`sessionStore.ts`）と同じ形をそのまま使っている。
 *
 * このファイルは拡張機能だけが書く。作者が手で編集する設定JSONとは違い、
 * そのまま置き換えてよい（`atomicWriteFile` を引数無しで呼ぶ）。
 */

/** 記録の置き場。作品フォルダー内・同期対象 */
const STATS_DIR = "stats";

export class WritingStatsStore {
  constructor(
    private readonly work: WorkEntry,
    private readonly deviceId: string
  ) {}

  private directory(): string {
    return path.join(workPaths(this.work).aiwriter, STATS_DIR);
  }

  private fileFor(deviceId: string): string {
    return path.join(this.directory(), `${deviceId}.json`);
  }

  /** この環境の記録。無ければ空の記録を返す */
  async loadOwn(): Promise<DeviceWritingStats> {
    const loaded = await this.readFile(this.fileFor(this.deviceId));
    return loaded ?? emptyDeviceStats(this.deviceId);
  }

  /**
   * 全端末の記録を読む。
   *
   * **壊れた記録は黙って捨てる。** 同期対象なので競合マーカーが混ざる
   * ことがあり、そこで例外を投げると統計が二度と開けなくなる。
   */
  async loadAll(): Promise<DeviceWritingStats[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(this.directory())
      );
    } catch {
      return [];
    }

    const sets: DeviceWritingStats[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
      const loaded = await this.readFile(path.join(this.directory(), name));
      if (loaded) sets.push(loaded);
    }
    return sets.sort((left, right) =>
      left.deviceId.localeCompare(right.deviceId)
    );
  }

  /**
   * 今の作品の姿を測って記録する。
   *
   * 数えなかった場合でも基準が変わっていれば保存する。
   * 増減が無かった回だけは書かない（`shouldPersist` を参照）。
   */
  async record(
    measurement: WritingMeasurement,
    options: { at?: Date; boundaryHour?: number } = {}
  ): Promise<RecordResult> {
    const current = await this.loadOwn();
    const result = recordMeasurement(current, measurement, options);
    if (shouldPersist(result)) await this.save(result.stats);
    return result;
  }

  /**
   * 記録を付けずに基準だけ置き直す。
   *
   * 別の環境の変更を取り込んだ直後に使う。取り込んだ量をこの環境の
   * 執筆量として数えると、同じ文章を2台ぶん数えることになる。
   */
  async rebaseline(
    measurement: WritingMeasurement,
    at: Date = new Date()
  ): Promise<void> {
    const current = await this.loadOwn();
    await this.save(rebaseline(current, measurement, at));
  }

  private async save(stats: DeviceWritingStats): Promise<void> {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(this.directory())
    );
    await atomicWriteFile(
      this.fileFor(this.deviceId),
      new TextEncoder().encode(`${JSON.stringify(stats, null, 2)}\n`)
    );
  }

  private async readFile(
    filePath: string
  ): Promise<DeviceWritingStats | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(filePath)
      );
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return parseDeviceWritingStats(parsed);
    } catch {
      return undefined;
    }
  }
}
