import * as vscode from "vscode";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  MEMO_MARKER_DEFS,
  memoMarkerLabels,
  memoMarkersOf,
  sameMemoMarkers,
  type MemoMarkerId,
  type MemoMarkers,
} from "../core/memoMarkers";
import { readMemoMarkers, writeMemoMarkers } from "../core/memoMarkerStore";
import { WorkConfigMissingError } from "../core/workKindStore";
import { linesStartingWithMarkers } from "../core/sceneMemo";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { formatChapterLabel } from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";

/**
 * メモ（付箋）の印を作品ごとに選ぶ（設計書6.40.8。作者の決定 2026-11-14 夜）。
 *
 * **本文は1字も書き換えない。** 変わるのは、どの行をメモと読むか（字数・投稿用のコピー・
 * 書き出し・AI へ送る本文から外す行）だけ。設定の在り処は作品の設定
 * （`.aiwriter/config.json` の `memoMarkers`）で、GitHub 同期で2台にそろう。
 *
 * VS Code の設定画面では作品を選べないので、詳細メニューの作品別設定から呼ぶ。
 *
 * @returns 切り替えたら新しい印の組。取りやめ・同じ組・読めないときは undefined
 */
export async function setMemoMarkers(work: WorkEntry): Promise<MemoMarkers | undefined> {
  let current: MemoMarkers;
  try {
    current = await readMemoMarkers(work);
  } catch (error) {
    // **壊れた設定は直さずに止める**（実装ルール2）。理由はそのまま出す
    void vscode.window.showErrorMessage(
      `メモの印を選べませんでした。${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }

  const picked = await showQuickPickKeepingFocus(
    MEMO_MARKER_DEFS.map((def) => ({
      label: def.label,
      detail: def.detail,
      picked: current.ids.includes(def.id),
      markerId: def.id,
    })),
    {
      canPickMany: true,
      title: `「${work.title}」のメモの印`,
      placeHolder: "行の頭に書くと、その行がメモ（付箋）になる印を選びます（複数選べます。本文は書き換えません）",
      ignoreFocusOut: true,
    }
  );
  if (!picked) return undefined;
  if (picked.length === 0) {
    void vscode.window.showWarningMessage(
      "メモの印は1つ以上選んでください。印を変えずに閉じました。"
    );
    return undefined;
  }
  const next = memoMarkersOf(picked.map((item) => item.markerId));
  if (sameMemoMarkers(current, next)) return undefined;

  /*
    **新しくオンにする印があるときは、切り替える前に数える**（作者の決定）。
    いまは本文として数えている行が、切り替えたとたんに字数・投稿用のコピー・書き出しから
    外れる。0件なら確かめずに切り替える
  */
  const added = memoMarkersOf(next.ids.filter((id) => !current.ids.includes(id)));
  if (added.ids.length > 0) {
    const found = await findMarkedLines(work, added);
    if (found.places.length > 0 || found.unreadable > 0) {
      const ok = await confirmSwitch(work, added, found);
      if (!ok) return undefined;
    }
  }

  try {
    await writeMemoMarkers(work, next.ids as MemoMarkerId[]);
  } catch (error) {
    if (error instanceof WorkConfigMissingError) {
      void vscode.window.showErrorMessage(
        `メモの印を変えられませんでした。${error.message}` +
          "作品一覧でこの作品の登録を解除し、同じフォルダーを登録し直すと作られます" +
          "（本文と設定資料のファイルはそのまま残ります）。"
      );
      return undefined;
    }
    void vscode.window.showErrorMessage(
      `メモの印を変えられませんでした。${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }

  void vscode.window.showInformationMessage(
    `「${work.title}」のメモの印を「${memoMarkerLabels(next)}」にしました。本文は変えていません。`
  );
  return next;
}

/** 新しい印で始まる行の場所（「第N話 M行目」） */
export interface MarkedLines {
  places: string[];
  /** 読めなかった話（競合の跡・読み取りの失敗）。数えられなかったことを隠さない */
  unreadable: number;
}

/**
 * その作品の本文で、新しくオンにする印で始まる行を数える（囲みなら `<!--` で始まる行）。
 * **読むだけ**（書き換えない）。
 */
export async function findMarkedLines(work: WorkEntry, added: MemoMarkers): Promise<MarkedLines> {
  const scan = await scanWork(work);
  let format: WorkFormatKey | undefined;
  try {
    format = await readWorkFormat(work);
  } catch {
    format = undefined;
  }
  const places: string[] = [];
  let unreadable = 0;
  for (const episode of scan.episodes) {
    if (episode.hasConflictMarkers) {
      unreadable += 1;
      continue;
    }
    let text: string;
    try {
      text = (await readTextFile(episode.filePath)).text;
    } catch {
      unreadable += 1;
      continue;
    }
    for (const line of linesStartingWithMarkers(text, added)) {
      places.push(`${episodeLabel(episode, format)} ${line}行目`);
    }
  }
  return { places, unreadable };
}

function episodeLabel(episode: EpisodeFile, format: WorkFormatKey | undefined): string {
  return formatChapterLabel(episode, format) || episode.fileName;
}

/** 切り替える前の確かめ。最初の5件ほどの場所を見せる */
async function confirmSwitch(
  work: WorkEntry,
  added: MemoMarkers,
  found: MarkedLines
): Promise<boolean> {
  const shown = found.places.slice(0, 5).join("、");
  const rest = found.places.length > 5 ? ` ほか${found.places.length - 5}か所` : "";
  const unreadable =
    found.unreadable > 0 ? `（読めなかった話が${found.unreadable}話あり、そこは数えていません）` : "";
  const detail =
    found.places.length > 0
      ? `「${work.title}」の本文に、${memoMarkerLabels(added)} で始まる行が${found.places.length}か所あります` +
        `（${shown}${rest}）${unreadable}。\n` +
        "これらの行は、字数・投稿用のコピー・書き出しから外れます（本文のファイルは書き換えません）。"
      : `「${work.title}」の本文に、${memoMarkerLabels(added)} で始まる行は見つかりませんでした${unreadable}。`;
  const choice = await vscode.window.showWarningMessage(
    `メモの印を切り替えますか？`,
    { modal: true, detail },
    "切り替える"
  );
  return choice === "切り替える";
}
