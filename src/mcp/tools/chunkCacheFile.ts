import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  ChunkCacheStore,
  type ChunkCacheIo,
} from "../../core/chunkCacheStore";
import { AIWRITER_DIR } from "../../models/types";

/**
 * 外から呼んだときも、チャンクキャッシュを使う（設計書6.87.17）。
 *
 * **拡張機能とまったく同じファイルを、同じ鍵で読み書きする。** 別の場所や
 * 別の鍵にすると、片方が貯めたぶんをもう片方が使えない——同じ本文を同じ
 * モデルへ二度送ることになり、実装ルール4（処理量を節約する）に反する。
 *
 * **ファイルの読み書きだけが違う。** MCPサーバーは VS Code の外で走るので
 * `vscode.workspace.fs` が無い（`mcpReach.test.ts`）。判断の中身は
 * `core/chunkCacheStore.ts` にあり、ここが渡すのは `node:fs` の手だけである。
 */

/** 拡張機能と同じ置き場所（`core/chunkCache.ts` の `chunkCacheFilePath`） */
export function chunkCacheFileOf(folder: string): string {
  return nodePath.join(
    nodePath.resolve(folder),
    AIWRITER_DIR,
    "cache",
    "chunks.json"
  );
}

const nodeIo: ChunkCacheIo = {
  async read(file) {
    // 無ければ「まだ何も貯まっていない」。作り直せるので騒がない
    if (!fs.existsSync(file)) return undefined;
    return fs.readFileSync(file);
  },
  async write(file, bytes) {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    /*
      **一時ファイルへ書いてから置き換える。** 同じファイルを拡張機能も
      読むので、書きかけを読ませると「壊れたJSON」に見える（読む側は空として
      扱うので止まりはしないが、貯めたぶんが丸ごと無かったことになる）。
      名前にプロセス番号を入れるのは、MCPサーバーが2つ動いていても
      一時ファイルがぶつからないようにするため。
    */
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, file);
  },
  log(message) {
    // **標準出力は JSON-RPC が使っている。** ここへ書くと通信が壊れる
    process.stderr.write(`${message}\n`);
  },
};

export function openChunkCache(folder: string): ChunkCacheStore {
  return new ChunkCacheStore(chunkCacheFileOf(folder), nodeIo);
}
