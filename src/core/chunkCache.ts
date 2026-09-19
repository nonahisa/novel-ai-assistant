import * as vscode from "vscode";
import * as path from "./paths";
import { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { logLine } from "./logger";
import { workPaths } from "./workRegistry";
import {
  ChunkCacheStore,
  type CacheKeyBase,
  type ChunkCacheIo,
} from "./chunkCacheStore";

/**
 * チャンク処理キャッシュ（拡張機能から使う側）。
 *
 * **中身は `chunkCacheStore.ts` にある。** 同じ `chunks.json` を
 * **MCPサーバー（別プロセス）も読み書きする**ので（設計書6.87.17）、
 * 鍵の作り方・混ぜ方・間引きの決まりは `vscode` に依らない場所へ置いてある
 * ——ここが持つのは「VS Code ではどう読み書きするか」だけである。
 */

export {
  CHUNK_CACHE_MAX_IDLE_DAYS,
  CHUNK_CACHE_MAX_ENTRIES,
  type CacheKeyBase,
} from "./chunkCacheStore";

/** キャッシュの置き場所（`.aiwriter/cache/chunks.json`）。**MCP側と同じ場所** */
export function chunkCacheFilePath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, "cache", "chunks.json");
}

/**
 * VS Code 側の読み書き。
 *
 * **書き込みは `atomicWriteFile`（指定なし＝上書き）。** チャンクキャッシュは
 * 作者が書いたものではなく作り直せるので、回復先への退避は持たない
 * （スキル `implement` の実装ルール2、経路①）。取りこぼしの防ぎ方は
 * 「書く直前に読み直して混ぜる」ほうで担う。
 */
const vscodeIo: ChunkCacheIo = {
  async read(file) {
    return await vscode.workspace.fs.readFile(path.toUri(file));
  },
  async write(file, bytes) {
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(file)));
    await atomicWriteFile(file, bytes);
  },
  log: logLine,
};

export class ChunkCache {
  private readonly store: ChunkCacheStore;

  constructor(work: WorkEntry, options: { now?: () => Date } = {}) {
    this.store = new ChunkCacheStore(
      chunkCacheFilePath(work),
      vscodeIo,
      options
    );
  }

  load(): Promise<void> {
    return this.store.load();
  }

  save(): Promise<void> {
    return this.store.save();
  }

  get(chunkHash: string, base: CacheKeyBase): unknown | undefined {
    return this.store.get(chunkHash, base);
  }

  set(chunkHash: string, base: CacheKeyBase, value: unknown): Promise<void> {
    return this.store.set(chunkHash, base, value);
  }

  get size(): number {
    return this.store.size;
  }
}
