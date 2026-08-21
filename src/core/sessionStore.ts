import * as path from "./paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { isValidDeviceId } from "./device";
import { workPaths } from "./workRegistry";

/**
 * 最終編集環境の記録（設計書5.5.2）。
 *
 * 同一人物が環境を渡り歩くため強制ロックは要らないが、
 * 「直前にどの環境で書いていたか」が分かると事故を防げる。
 * ロックはせず情報提示にとどめるので、異常終了しても詰まらない。
 *
 * **設計書からの変更：1ファイルではなく端末ごとに分ける。**
 * 設計書5.5.2は `.aiwriter/session.json` 1つを共有する形だったが、
 * それでは2台で書いた瞬間に必ず競合する。同じ理由で統計を端末ごとに
 * 分ける判断を5.5.6が既にしているので、こちらも合わせた。
 * 書き込むのは自分の端末のファイルだけなので、構造上競合しない。
 */

/** 記録の置き場。作品フォルダー内・同期対象 */
const SESSIONS_DIR = "sessions";

export interface SessionRecord {
  deviceId: string;
  /** 最後に編集した時刻（ISO8601、オフセット付き） */
  lastEditedAt: string;
  /** 作品フォルダーからの相対パス。環境で絶対パスが違うため */
  lastEditedFile: string;
}

export class SessionStore {
  constructor(
    private readonly work: WorkEntry,
    private readonly deviceId: string
  ) {}

  private directory(): string {
    return path.join(workPaths(this.work).aiwriter, SESSIONS_DIR);
  }

  private fileFor(deviceId: string): string {
    return path.join(this.directory(), `${deviceId}.json`);
  }

  /**
   * この環境の記録を残す。
   *
   * **編集（保存）したときだけ呼ぶこと。** ファイルを開いただけで書くと、
   * 何も書いていないのに作業ツリーが汚れ、「未コミットの変更がある」
   * という理由で取り込みが止まるようになる。自分の記録で自分を
   * 邪魔することになる。
   */
  async record(manuscriptPath: string): Promise<void> {
    const relative = path
      .relative(this.work.folderPath, manuscriptPath)
      .split(path.sep)
      .join("/");

    const record: SessionRecord = {
      deviceId: this.deviceId,
      lastEditedAt: new Date().toISOString(),
      lastEditedFile: relative,
    };

    await vscode.workspace.fs.createDirectory(
      path.toUri(this.directory())
    );
    // 拡張機能だけが書くファイルなので、そのまま置き換えてよい
    // （作者が手で編集する設定JSONとは扱いが違う）
    await atomicWriteFile(
      this.fileFor(this.deviceId),
      new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`)
    );
  }

  /** 自分の記録 */
  async ownRecord(): Promise<SessionRecord | undefined> {
    const records = await this.loadAll();
    return records.find((record) => record.deviceId === this.deviceId);
  }

  /**
   * 別の環境の記録のうち、いちばん新しいもの。
   * 自分の記録より古ければ知らせる意味がないので undefined を返す。
   */
  async newerElsewhere(): Promise<SessionRecord | undefined> {
    const records = await this.loadAll();
    const own = records.find((record) => record.deviceId === this.deviceId);
    const ownTime = own ? Date.parse(own.lastEditedAt) : 0;

    return records
      .filter((record) => record.deviceId !== this.deviceId)
      .filter((record) => Date.parse(record.lastEditedAt) > ownTime)
      .sort(
        (left, right) =>
          Date.parse(right.lastEditedAt) - Date.parse(left.lastEditedAt)
      )[0];
  }

  /**
   * すべての記録を読む。
   *
   * **壊れた記録は黙って捨てる。** 同期対象なので競合マーカーが
   * 混ざることがあり、そこで例外を投げると執筆そのものが止まる。
   * 記録は失われても実害がない種類の情報である。
   */
  async loadAll(): Promise<SessionRecord[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        path.toUri(this.directory())
      );
    } catch {
      return [];
    }

    const records: SessionRecord[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(
          path.toUri(path.join(this.directory(), name))
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const record = parseSessionRecord(parsed);
        if (record) records.push(record);
      } catch {
        // 壊れた1件で全体を諦めない
      }
    }
    return records;
  }
}

/** 記録として使える形かを確かめる。想像で補わない */
export function parseSessionRecord(value: unknown): SessionRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.deviceId !== "string" || !isValidDeviceId(raw.deviceId)) {
    return undefined;
  }
  if (typeof raw.lastEditedAt !== "string") return undefined;
  if (!Number.isFinite(Date.parse(raw.lastEditedAt))) return undefined;
  if (typeof raw.lastEditedFile !== "string") return undefined;

  return {
    deviceId: raw.deviceId,
    lastEditedAt: raw.lastEditedAt,
    lastEditedFile: raw.lastEditedFile,
  };
}

/**
 * 「デスクトップで3時間前に第8話を編集しています」の一文を作る。
 *
 * 経過時間を添えるのは、**古い記録なら気にしなくてよい**と
 * 判断できるようにするため。「別の環境で編集しています」だけでは、
 * それが1分前なのか半年前なのか分からない。
 */
export function describeOtherDeviceSession(
  record: SessionRecord,
  now: Date = new Date()
): string {
  const elapsed = describeElapsed(
    now.getTime() - Date.parse(record.lastEditedAt)
  );
  const fileName = record.lastEditedFile
    ? path.basename(record.lastEditedFile)
    : "";
  const target = fileName ? `${fileName} を` : "";
  return `別の環境（${record.deviceId}）が${elapsed}に${target}編集しています。`;
}

/** 経過時間をおおまかな日本語にする */
export function describeElapsed(milliseconds: number): string {
  if (milliseconds < 0) return "これから";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}か月前`;
  return `${Math.floor(months / 12)}年前`;
}
