import * as vscode from "vscode";
import * as path from "./paths";
import { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { atomicWriteFile } from "./atomicWrite";
import {
  VECTOR_INDEX_DIR,
  VECTOR_INDEX_META_FILE,
  VECTOR_INDEX_VECTORS_FILE,
  VECTOR_INDEX_VERSION,
  decodeVectors,
  isStoredMeta,
  nearestByCosine,
  type StoredMeta,
} from "./vectorIndexFormat";

/**
 * 意味検索のための索引（ベクトルDB）。
 *
 * ## 置き場所と同期
 *
 * `.aiwriter/cache/` に置く。**ここは既にGit除外されている**ので、
 * 数MBの索引がGitHubへ流れ込むことはない。代わりに端末ごとに作り直しが要る。
 * 実データ（78.5万字・219話・2,541件）で39秒だったので、それで釣り合う。
 *
 * ## 形式
 *
 * ベクトルは `vectors.bin`（float32の並び）、対応表は `index.json`。
 * JSONに数値の配列で入れると、2,541件で数十MBの文字列になり
 * 読み書きが重い。バイナリなら同じ内容が9.9MBで済む。
 *
 * ## 作り直しの単位
 *
 * **内容ハッシュで持つ。** 1話直したらその話の場面だけ作り直す。
 * 実測で1話ぶん12件＝0.2秒。既存の `chunkCache.ts` と同じ考え方。
 * モデル名も鍵に含める。別のモデルで作ったベクトルは混ぜると
 * 距離が意味を持たなくなるため、モデルを変えたら全部作り直す。
 */

/*
  形の解釈・ベクトルの並べ方・近さの計算は `vectorIndexFormat.ts`（VS Code に
  依存しない葉）にある。MCP の `novel.search` も同じ索引を読むため（0.99.19）
*/
export { VECTOR_INDEX_VERSION } from "./vectorIndexFormat";

export interface VectorEntry {
  hash: string;
  vector: Float32Array;
}

export class VectorIndex {
  private readonly byHash = new Map<string, Float32Array>();
  private model = "";
  private dimensions = 0;
  /** 埋め込みに使った Ollama の場所（記録に残す。MCP が同じ場所で検索語を埋め込む） */
  private endpoint: string | undefined;

  private constructor() {}

  static empty(): VectorIndex {
    return new VectorIndex();
  }

  get size(): number {
    return this.byHash.size;
  }

  get modelName(): string {
    return this.model;
  }

  has(hash: string): boolean {
    return this.byHash.has(hash);
  }

  get(hash: string): Float32Array | undefined {
    return this.byHash.get(hash);
  }

  set(hash: string, vector: Float32Array): void {
    if (this.dimensions === 0) this.dimensions = vector.length;
    this.byHash.set(hash, vector);
  }

  setModel(model: string): void {
    this.model = model;
  }

  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
  }

  /**
   * 使われなくなったベクトルを落とす。
   *
   * 本文を書き換えるたびに古い場面のベクトルが残ると、
   * 索引が延々と太る。作り直しのたびに掃除する。
   */
  retainOnly(hashes: Iterable<string>): number {
    const keep = new Set(hashes);
    let removed = 0;
    for (const hash of [...this.byHash.keys()]) {
      if (!keep.has(hash)) {
        this.byHash.delete(hash);
        removed++;
      }
    }
    return removed;
  }

  /**
   * 近い順に返す。
   *
   * 総当たりで計算する。**近似検索の仕組みは入れない。** 実測で
   * 2,541件・1024次元の総当たりが1問219ms（質問の埋め込み込み）で、
   * 作品1つぶんの規模では十分速い。近似の仕組みを入れると
   * 依存も、索引の作り直しの手間も増える。
   */
  search(
    query: Float32Array,
    candidates: readonly { id: string; hash: string }[],
    limit: number
  ): Array<{ id: string; score: number }> {
    return nearestByCosine((hash) => this.byHash.get(hash), query, candidates, limit);
  }

  // ─── 保存と読み込み ───

  static async load(work: WorkEntry, model: string): Promise<VectorIndex> {
    const index = new VectorIndex();
    const paths = indexPaths(work);
    try {
      const metaBytes = await vscode.workspace.fs.readFile(
        path.toUri(paths.meta)
      );
      const meta: unknown = JSON.parse(new TextDecoder().decode(metaBytes));
      if (!isStoredMeta(meta)) return index;
      // 版かモデルが違えば、読まずに空から作り直す。
      // 別のモデルのベクトルと混ぜると距離が意味を失う
      if (meta.version !== VECTOR_INDEX_VERSION || meta.model !== model) {
        return index;
      }

      const binBytes = await vscode.workspace.fs.readFile(
        path.toUri(paths.vectors)
      );
      // 途中で切れた索引は使わない（undefined）。作り直せば済む
      const vectors = decodeVectors(meta, binBytes);
      if (!vectors) return index;
      for (const [hash, vector] of vectors) index.byHash.set(hash, vector);
      index.model = meta.model;
      index.dimensions = meta.dimensions;
      index.endpoint = meta.endpoint;
    } catch {
      // 索引は失われても作り直せる。読めなくても空で続行する
    }
    return index;
  }

  async save(work: WorkEntry): Promise<void> {
    const paths = indexPaths(work);
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(paths.meta))
    );

    const hashes = [...this.byHash.keys()];
    const dimensions = this.dimensions;
    const bin = new Float32Array(hashes.length * dimensions);
    hashes.forEach((hash, i) => {
      const vector = this.byHash.get(hash);
      if (vector) bin.set(vector, i * dimensions);
    });

    const meta: StoredMeta = {
      version: VECTOR_INDEX_VERSION,
      model: this.model,
      dimensions,
      hashes,
      // **任意の欄**（版は上げない）。MCP の novel.search が作成日時と
      // 検索語を埋め込む場所に使う
      builtAt: new Date().toISOString(),
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
    };

    // キャッシュなので上書きでよい（作者のデータではない）
    await atomicWriteFile(
      paths.vectors,
      new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength)
    );
    await atomicWriteFile(
      paths.meta,
      new TextEncoder().encode(JSON.stringify(meta))
    );
  }

  /** 索引を消す。設定を切ったときや、作り直したいときに使う */
  static async remove(work: WorkEntry): Promise<void> {
    const paths = indexPaths(work);
    for (const target of [paths.vectors, paths.meta]) {
      try {
        await vscode.workspace.fs.delete(path.toUri(target));
      } catch {
        // 無ければそれでよい
      }
    }
  }

  /** 保存されている大きさ（バイト）。作者に費用を示すために使う */
  static async storedBytes(work: WorkEntry): Promise<number> {
    const paths = indexPaths(work);
    let total = 0;
    for (const target of [paths.vectors, paths.meta]) {
      try {
        const stat = await vscode.workspace.fs.stat(path.toUri(target));
        total += stat.size;
      } catch {
        // 無ければ0
      }
    }
    return total;
  }
}

function indexPaths(work: WorkEntry): { vectors: string; meta: string } {
  // `.aiwriter` は `workPaths` の決め方に従う（`VECTOR_INDEX_DIR` の頭と同じ）
  const base = path.join(workPaths(work).aiwriter, ...VECTOR_INDEX_DIR.slice(1));
  return {
    vectors: path.join(base, VECTOR_INDEX_VECTORS_FILE),
    meta: path.join(base, VECTOR_INDEX_META_FILE),
  };
}
