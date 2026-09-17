import { Uri, workspace } from "vscode";
import * as path from "../../../src/core/paths";
import {
  setTuningStoreRoot,
  TUNING_STORE_FILE,
} from "../../../src/core/modelTuningStore";

/**
 * AIチューニングの台帳（`core/modelTuningStore.ts`）を、**記憶の中の
 * ファイルだけ**で動かすための下ごしらえ。
 *
 * 0.66.5 までの台帳は VS Code の設定だったので、テストは
 * `workspace.getConfiguration` を差し替えるだけで済んでいた。0.66.6 で
 * 拡張機能の保管庫のファイルへ移したため、**書き込みの道（一時ファイル →
 * 置き換え）も含めて本物と同じ経路を通す**必要がある。
 *
 * **作り物を本物より親切にしない。** 書き込みは `atomicWriteFile` が
 * 通るので、`writeFile` と `rename` の両方を持つ。片方だけにすると、
 * 実機では落ちる書き方がテストでは通ってしまう。
 */

/** 台帳を置く、架空の保管庫 */
export const TUNING_ROOT = "C:/novelai-test-storage";

/** 記憶の中のファイル。鍵はURIの文字列（道の書き方の揺れを避ける） */
const files = new Map<string, Uint8Array>();

/** 台帳のファイルを置き換えた回数（`fsTiming.failWriteAt` の判断に使う） */
let writeCount = 0;

/**
 * 作られている置き場。
 *
 * **本物と同じく、無い置き場へは書けない。** 拡張機能の保管庫は、
 * その機械で初めて動かしたときには存在しない。ここを素通しにすると、
 * **引っ越しの1件目から書けない**という実機でしか出ない壊れ方を
 * 作ってしまう（作り物を本物より親切にしない）。
 */
const directories = new Set<string>();

/** その場所の、1つ上の置き場 */
function parentOf(key: string): string {
  return key.slice(0, key.lastIndexOf("/"));
}

/**
 * 書き込みにかかる時間（ミリ秒）。
 *
 * **「読んでから書くまでの隙間」を作るために要る。** 2つの窓の取り合いを
 * 再現するテストが、ここを延ばして割り込む。
 */
export const fsTiming = {
  delayMs: 0,
  /**
   * 何回目の「置き換え」を失敗させるか（1始まり）。
   *
   * 書けない置き場（権限・容量）の再現に使う。**途中で投げても、延ばした
   * 待ち時間が台帳に残らないこと**を確かめるテストが要る。
   */
  failWriteAt: undefined as number | undefined,
};

/**
 * 台帳のファイルへ書かれた中身の**履歴**。
 *
 * 最後の状態だけを見ると「一度は延ばした」ことが確かめられない
 * ——そもそも延ばさなかった場合と区別が付かず、戻せているテストが
 * 空振りしていても気づけない。
 */
export const tuningWrites: Record<string, unknown>[] = [];

function keyOf(uri: { toString(): string }): string {
  return uri.toString();
}

async function pause(): Promise<void> {
  if (fsTiming.delayMs > 0) {
    await new Promise((done) => setTimeout(done, fsTiming.delayMs));
  }
}

/** 記憶の中のファイル装置を `vscode.workspace.fs` に差し込む */
export function installMemoryFileSystem(): void {
  (workspace as { fs: unknown }).fs = {
    readFile: async (uri: { toString(): string }): Promise<Uint8Array> => {
      const bytes = files.get(keyOf(uri));
      if (!bytes) throw new Error(`ありません: ${uri.toString()}`);
      return bytes;
    },
    writeFile: async (
      uri: { toString(): string },
      bytes: Uint8Array
    ): Promise<void> => {
      if (!directories.has(parentOf(keyOf(uri)))) {
        throw new Error(`置き場がありません: ${parentOf(keyOf(uri))}`);
      }
      await pause();
      files.set(keyOf(uri), bytes);
    },
    rename: async (
      from: { toString(): string },
      to: { toString(): string }
    ): Promise<void> => {
      const bytes = files.get(keyOf(from));
      if (!bytes) throw new Error(`ありません: ${from.toString()}`);
      if (keyOf(to) === tuningFileKey()) {
        writeCount += 1;
        if (writeCount === fsTiming.failWriteAt) {
          throw new Error("書き込めませんでした");
        }
      }
      files.delete(keyOf(from));
      files.set(keyOf(to), bytes);
      if (keyOf(to) === tuningFileKey()) {
        tuningWrites.push(
          JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
        );
      }
    },
    delete: async (uri: { toString(): string }): Promise<void> => {
      files.delete(keyOf(uri));
    },
    stat: async (uri: { toString(): string }): Promise<{ type: number }> => {
      if (!files.has(keyOf(uri))) throw new Error(`ありません: ${uri.toString()}`);
      return { type: 1 };
    },
    createDirectory: async (uri: { toString(): string }): Promise<void> => {
      directories.add(keyOf(uri));
    },
  };
}

/** その置き場が作られているか（製品が作ったかを見るのに使う） */
export function tuningStoreDirectoryExists(): boolean {
  return directories.has(parentOf(tuningFileKey()));
}

/** 台帳のファイルの場所（URIの文字列） */
function tuningFileKey(): string {
  return keyOf(path.toUri(path.join(TUNING_ROOT, TUNING_STORE_FILE)));
}

/**
 * 台帳を、記憶の中のファイルで始める。
 *
 * @param initial ファイルの初期の中身。**渡さないと「ファイルがまだ無い」**
 *   になるので、設定からの引っ越しが走る（引っ越しを確かめるテストが使う）。
 *   `{}` を渡せば「空のファイルがある」＝引っ越し済みの状態になる
 */
export async function useMemoryTuningStore(
  initial?: Record<string, unknown>
): Promise<void> {
  resetMemoryFileSystem();
  if (initial !== undefined) writeTuningStoreDirectly(initial);
  await setTuningStoreRoot(Uri.file(TUNING_ROOT));
}

/** 記憶の中のファイル装置を、まっさらに戻す */
function resetMemoryFileSystem(): void {
  files.clear();
  // **保管庫は最初から在るとは限らない。** 作るのは製品の仕事である
  directories.clear();
  writeCount = 0;
  tuningWrites.length = 0;
  fsTiming.delayMs = 0;
  fsTiming.failWriteAt = undefined;
  installMemoryFileSystem();
}

/** いま台帳のファイルに入っている中身 */
export function tuningStoreContents(): Record<string, unknown> {
  const bytes = files.get(tuningFileKey());
  if (!bytes) return {};
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** 台帳のファイルが、そもそも在るか */
export function tuningStoreFileExists(): boolean {
  return files.has(tuningFileKey());
}

/**
 * 製品の道を通さずに、台帳のファイルへ直に書く。
 *
 * **別の窓が書いた**状況を作るためのもので、普段は使わない。
 */
export function writeTuningStoreDirectly(table: unknown): void {
  // ファイルが在るということは、置き場も在るということである
  directories.add(parentOf(tuningFileKey()));
  files.set(
    tuningFileKey(),
    new TextEncoder().encode(`${JSON.stringify(table, null, 2)}\n`)
  );
}

/** 台帳のファイルを壊す（読めないJSONにする） */
export function breakTuningStoreFile(): void {
  directories.add(parentOf(tuningFileKey()));
  files.set(tuningFileKey(), new TextEncoder().encode("{ 壊れている"));
}

/** 壊れたファイルがある状態で始める（読めないJSONを置いてから置き場を渡す） */
export async function useBrokenTuningStore(): Promise<void> {
  resetMemoryFileSystem();
  breakTuningStoreFile();
  await setTuningStoreRoot(Uri.file(TUNING_ROOT));
}
