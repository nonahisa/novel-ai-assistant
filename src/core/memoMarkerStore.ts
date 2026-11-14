import type { WorkConfig, WorkEntry } from "../models/types";

import { findWorkForFile, readWorkConfig, writeWorkConfig } from "./workRegistry";
import {
  DEFAULT_MEMO_MARKERS,
  MEMO_MARKER_IDS,
  memoMarkersOf,
  resolveMemoMarkers,
  type MemoMarkerId,
  type MemoMarkers,
} from "./memoMarkers";
import { WorkConfigMissingError } from "./workKindStore";

/**
 * 作品のメモの印を読む・書く口（設計書6.40.8）。**拡張機能の側はここ1か所を通す**
 * （MCP は `vscode` を引けないので `mcp/tools/memoMarkersOfFolder.ts` が同じ解釈関数を呼ぶ）。
 *
 * 在り処は作品の設定（`.aiwriter/config.json` の `memoMarkers`）。種類（`kind`）と同じく
 * 機械が読む設定で、GitHub 同期で2台にそろう（`.aiwriter/cache/` のような同期の外ではない）。
 *
 * ## 読むたびに設定ファイルを読む
 *
 * 種類（`workKindStore.ts`）は覚えておくが、印は覚えない。印を取り違えると、メモの行が
 * 投稿用のコピーへ出る（公開事故）。もう1台で切り替えて GitHub から取り込んだあとも、
 * 古い印のまま書き出すことがないよう、字数・投稿・書き出し・AI の入口では毎回読む
 * （小さなファイルを1回読むだけで、話ごとには読まない）。
 *
 * 覚えておくのは、同期でしか引けない所（Markdown のプレビュー）のための写しだけ
 * （`cachedMemoMarkersForPath`）。読むたびに上書きされる。
 */

/** 作品フォルダー → 最後に読んだ印 */
const lastRead = new Map<string, MemoMarkers>();


/**
 * その作品の印。設定ファイルが無ければ既定（`//` と `／／`）。
 * **壊れていれば投げる**（直さずに止める。実装ルール2）——理由は呼んだ側がそのまま出す。
 */
export async function readMemoMarkers(work: WorkEntry): Promise<MemoMarkers> {
  const config = await readWorkConfig(work);
  const markers = resolveMemoMarkers(config?.memoMarkers);
  lastRead.set(work.folderPath, markers);
  return markers;
}

/**
 * 最後に読んだ印のうち、そのファイルを含む作品のもの。読んだことが無ければ undefined。
 *
 * **同期でしか引けない所（プレビュー）だけが使う。** 字数・投稿・書き出し・AI の入口は
 * `readMemoMarkers` で毎回読むこと。
 */
export function cachedMemoMarkersForPath(filePath: string): MemoMarkers | undefined {
  const found = findWorkForFile(
    [...lastRead.keys()].map((folderPath) => ({ folderPath })),
    filePath
  );
  return found ? lastRead.get(found.folderPath) : undefined;
}

/**
 * そのファイルを含む作品の印。**作品の外のファイルなら既定**（`//` と `／／`）。
 * 作品の中なら `readMemoMarkers` と同じく、壊れた設定では投げる。
 */
export async function readMemoMarkersForFile(
  works: readonly WorkEntry[],
  filePath: string
): Promise<MemoMarkers> {
  const work = findWorkForFile(works, filePath);
  return work ? readMemoMarkers(work) : DEFAULT_MEMO_MARKERS;
}

/** 変えたことを知らせる先（開いている原稿エディター・付箋のパネル） */
type MemoMarkersListener = (work: WorkEntry, markers: MemoMarkers) => void;
const listeners = new Set<MemoMarkersListener>();

export function onDidChangeMemoMarkers(listener: MemoMarkersListener): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

/**
 * 印を書く。**本文には触れない**（印を切り替えても、変わるのはどの行をメモと読むかだけ）。
 *
 * 設定ファイルが無い作品では `WorkConfigMissingError` を、壊れている作品では読み込みの
 * 失敗をそのまま投げる。**知らない名前（新しい版の印）は書かれたまま残す。**
 */
export async function writeMemoMarkers(work: WorkEntry, ids: readonly MemoMarkerId[]): Promise<MemoMarkers> {
  const config = await readWorkConfig(work);
  if (!config) throw new WorkConfigMissingError();
  const markers = memoMarkersOf(ids);
  if (markers.ids.length === 0) throw new Error("メモの印を1つ以上選んでください。");
  const unknown = (config.memoMarkers ?? []).filter(
    (id) => !(MEMO_MARKER_IDS as readonly string[]).includes(id)
  );
  const next: WorkConfig = { ...config, memoMarkers: [...markers.ids, ...unknown] };
  await writeWorkConfig(work, next);
  lastRead.set(work.folderPath, markers);
  for (const listener of listeners) {
    try {
      listener(work, markers);
    } catch {
      // 知らせる先の失敗で、書いた印を戻さない（書き込みは済んでいる）
    }
  }
  return markers;
}

export { DEFAULT_MEMO_MARKERS };
