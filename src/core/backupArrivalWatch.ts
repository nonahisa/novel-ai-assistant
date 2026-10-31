/**
 * バックアップを待っているあいだ、ダウンロードのフォルダーに来たファイルに気づく
 * （作者の指示 2026-11-01、受け渡しの形は作者「この形で作る」）。
 *
 * ## 見るのは名前だけ
 *
 * ［バックアップを取る］を押した時点でフォルダーにあった名前を控え、**そのあとに
 * 現れた名前だけ**を見る。名前がその作品のバックアップらしいとき
 * （`looksLikeBackupOf`）だけ、大きさを尋ねる。ほかのファイルは開かないし、
 * 大きさも尋ねない。中身を読むのは、作者が［取り込む］を押してから。
 *
 * ## 書き終わるまで待つ
 *
 * ブラウザは書きかけを `.crdownload` などの名前で置き、書き終わると名前を変える。
 * 名前の変わらないブラウザに備えて、**2回続けて同じ大きさ（0より大きい）**に
 * なってから知らせる——書きかけの ZIP を読ませると、壊れたファイルと見分けがつかない。
 *
 * ## 30分で止まる
 *
 * 押したまま忘れられても、見張りが残り続けないように。止まったら知らせる側が言う。
 *
 * ## ここは時計もフォルダーも持たない
 *
 * 名前の一覧と大きさの尋ね方（`lister`）・時計（`now`）・刻み（`schedule`）を外から
 * 受ける。試験では一時フォルダーと偽の時計で回せる。Node の `fs` を読む部品は
 * `features/downloadFolderNode.ts`（ブラウザ版では読み込まない）。
 *
 * VS Code API には依存しない。
 */

import { looksLikeBackupOf, type UnregisteredOwnWork } from "./unregisteredOwnWorks";

/** 待つ長さの上限（作者の指示「30分まで」） */
export const BACKUP_WAIT_LIMIT_MS = 30 * 60 * 1000;

/** フォルダーを見直す間隔 */
export const BACKUP_POLL_INTERVAL_MS = 2000;

/** フォルダーを見る口 */
export interface DownloadFolderLister {
  /** フォルダーにあるファイルの名前（中は開かない） */
  names(): Promise<readonly string[]>;
  /** そのファイルの大きさ（バイト）。無ければ undefined */
  size(name: string): Promise<number | undefined>;
}

export interface BackupArrivalWatchOptions {
  readonly target: Pick<UnregisteredOwnWork, "site" | "workId" | "title">;
  readonly lister: DownloadFolderLister;
  readonly now?: () => number;
  readonly limitMs?: number;
}

/** 1回見たときの結果 */
export type BackupArrivalStep =
  | { readonly kind: "waiting" }
  | { readonly kind: "arrived"; readonly names: readonly string[] }
  | { readonly kind: "expired" };

/**
 * 1作品ぶんの待ち。`start()` で押した時点の名前を控え、`poll()` を呼ぶたびに見直す。
 * 一度知らせた名前は二度と知らせない（作者が［取り込まない］を押したものを繰り返さない）。
 */
export class BackupArrivalWatch {
  private before: Set<string> | undefined;
  private readonly sizes = new Map<string, number>();
  private readonly announced = new Set<string>();
  private startedAt = 0;
  private readonly now: () => number;
  private readonly limitMs: number;

  constructor(private readonly options: BackupArrivalWatchOptions) {
    this.now = options.now ?? (() => Date.now());
    this.limitMs = options.limitMs ?? BACKUP_WAIT_LIMIT_MS;
  }

  /** 押した時点の名前を控える（フォルダーが読めなければ投げる。呼ぶ側が理由を言う） */
  async start(): Promise<void> {
    this.before = new Set(await this.options.lister.names());
    this.startedAt = this.now();
  }

  /** 待ちを始めてからの時間が上限を過ぎたか */
  expired(): boolean {
    return this.now() - this.startedAt >= this.limitMs;
  }

  async poll(): Promise<BackupArrivalStep> {
    if (!this.before) throw new Error("待ちを始める前に見直しています。");
    if (this.expired()) return { kind: "expired" };
    const names = await this.options.lister.names();
    const present = new Set(names);
    const arrived: string[] = [];
    for (const name of names) {
      if (this.before.has(name) || this.announced.has(name)) continue;
      // 名前がこの作品のものらしくなければ、大きさも尋ねない
      if (!looksLikeBackupOf(name, this.options.target)) continue;
      const size = await this.options.lister.size(name);
      if (size === undefined || size <= 0) {
        this.sizes.delete(name);
        continue;
      }
      if (this.sizes.get(name) === size) {
        this.announced.add(name);
        this.sizes.delete(name);
        arrived.push(name);
      } else {
        this.sizes.set(name, size);
      }
    }
    // 消えたファイルの控えは捨てる（同じ名前で落とし直したら、また測る）
    for (const name of [...this.sizes.keys()]) {
      if (!present.has(name)) this.sizes.delete(name);
    }
    return arrived.length > 0 ? { kind: "arrived", names: arrived } : { kind: "waiting" };
  }
}
