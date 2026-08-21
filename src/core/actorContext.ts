import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { DEFAULT_MODE, type WorkMode } from "./editorMode";
import { EditHistory, type EditHistoryEntry } from "./editHistory";
import type { ActorKind } from "../models/actor";
import { tryGitUserName } from "./gitAttribution";

/**
 * いまの環境が誰として動いているか（設計書5.6）。
 *
 * **モードは環境ごとの設定である。** 編集部は自分のパソコンにこの拡張機能を
 * 入れ、その環境を編集者モードにする。作品ごとではない（同じ人が
 * 作品ごとに立場を変えることは想定しない）。
 */

export function currentMode(): WorkMode {
  const configured = vscode.workspace
    .getConfiguration("novelai")
    .get<string>("mode", DEFAULT_MODE);
  return configured === "editor" ? "editor" : "author";
}

export function isEditorMode(): boolean {
  return currentMode() === "editor";
}

/**
 * 手で行った操作の記録者。
 *
 * **AIの操作はここを通さない。** AIが提案し作者が承諾したものは
 * `"ai"` として記録する（`recordEdit` の呼び出し側で指定する）。
 */
export function manualActor(): ActorKind {
  return isEditorMode() ? "editor" : "author";
}

/**
 * 編集履歴へ1件残す。
 *
 * **誰の名前で残すかは git の `user.name` を使う。** コミットの著者欄と
 * 同じものにしておくと、競合の画面に出る名前と履歴の名前が揃う。
 * 揃っていないと、作者は同じ人だと分からない。
 */
export async function recordEdit(
  work: WorkEntry,
  entry: {
    actor: ActorKind;
    action: string;
    file?: string;
    detail?: string;
  }
): Promise<void> {
  const record: EditHistoryEntry = {
    time: new Date().toISOString(),
    actor: entry.actor,
    actorName: (await safeUserName(work)) ?? "",
    action: entry.action,
    file: entry.file ?? "",
    detail: entry.detail ?? "",
  };
  await new EditHistory(work).append(record);
}

async function safeUserName(work: WorkEntry): Promise<string | undefined> {
  try {
    return await tryGitUserName(work.folderPath);
  } catch {
    // **名前が取れなくても履歴は残す。** 誰かが分からないより、
    // 記録が無いほうが困る
    return undefined;
  }
}
