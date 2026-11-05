/**
 * 編集者モードで出す作品の見分け（作者の指示 2026-11-05 夜「編集モードだと自分の作品を出さないように
 * してください」。設計書5.6.6）。
 *
 * 作者モードで自分の作品を登録したあと「作者／編集者切替」で編集者モードにした環境では、登録簿に
 * 自分の作品と参加した作品が混ざる。編集者メニューには参加した作品だけを出す。
 *
 * **0.127.x までに参加した作品には印が無い**（kmizu さんの作品）。それが消えて見えると困るので、
 * 手がかりで参加した作品とみなし、**決めきれないものは出す**側に倒す。出さないのは、印も置き場も
 * 写しの印も無いと確かめられた作品だけ。
 *
 * VS Code に依らない（写しの印を読むのは呼ぶ側）。
 */
import type { WorkEntry } from "../models/types";
import { EDITING_HOME_FOLDER } from "./editingRepo";

/** 作品フォルダーの写しの印（`.aiwriter/editor-share-manifest.json` が在り、作者の印が無い） */
export type EditorCopyMark = "present" | "absent" | "unknown";

/** 参加の置き場（`<既定の置き場>/編集部/<リポジトリ名>`。`joinEditorDestination`）の下か */
export function isUnderEditingHome(folderPath: string): boolean {
  return folderPath.split(/[\\/]+/).includes(EDITING_HOME_FOLDER);
}

/**
 * 編集者メニューに出す（参加した）作品か。
 *
 * 1. 参加で登録した印（`joinedAsEditor`。0.127.7 から付く）
 * 2. 参加の置き場（`編集部/`）の下にある
 * 3. 編集用の写しの印がある（作者が「編集者へ渡す」で置く印。取り寄せた写しにそのまま入っている）
 * 4. 写しの印が読めない——決めきれないので出す
 */
export function isJoinedWork(work: WorkEntry, copyMark: EditorCopyMark): boolean {
  if (work.joinedAsEditor) return true;
  if (isUnderEditingHome(work.folderPath)) return true;
  return copyMark !== "absent";
}
