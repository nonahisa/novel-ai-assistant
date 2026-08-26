import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { atomicWriteFile } from "./atomicWrite";
import {
  emptyExtractedIndex,
  parseExtractedIndex,
  recordExtracted,
  type EpisodeContent,
  type ExtractedIndex,
} from "./extractedIndex";

/**
 * 「どの話を取り込んだか」の記録の置き場（設計書6.21.3）。
 *
 * `.aiwriter/extracted.json`。**同期の対象に入れる**——別の環境で抽出した
 * なら、こちらでも抽出済みとして扱えるのが正しい（`.gitignore` へは
 * 足さない）。
 *
 * このファイルは拡張機能だけが書く。作者が手で編集する設定JSONとは違い、
 * そのまま置き換えてよい（`atomicWriteFile` を引数無しで呼ぶ）。
 */

const FILE_NAME = "extracted.json";

function filePath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, FILE_NAME);
}

/**
 * 記録を読む。無ければ undefined（＝一度も抽出していない）。
 *
 * **読めなくても投げない。** 壊れた記録のせいで抽出そのものが止まると、
 * 直す手立てが無くなる。
 */
export async function readExtractedIndex(
  work: WorkEntry
): Promise<ExtractedIndex | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(filePath(work))
    );
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parseExtractedIndex(raw);
  } catch {
    return undefined;
  }
}

/**
 * 抽出した話を書き留める。
 *
 * **失敗しても、抽出の結果は捨てない。** ここは「次に何話ぶん残っているか」
 * を数えるためだけの記録である。書けなかったとしても、資料そのものは
 * 保存できている。
 */
export async function writeExtractedIndex(
  work: WorkEntry,
  episodes: readonly EpisodeContent[]
): Promise<void> {
  const current = (await readExtractedIndex(work)) ?? emptyExtractedIndex();
  const next = recordExtracted(current, episodes);
  const p = filePath(work);
  await vscode.workspace.fs.createDirectory(
    path.toUri(workPaths(work).aiwriter)
  );
  await atomicWriteFile(
    p,
    new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`)
  );
}
