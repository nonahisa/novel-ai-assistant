import * as vscode from "vscode";
import {
  parseCollectedFile,
  type CollectedEpisode,
} from "../core/collectedFile";
import { collectedChapterLabel, isCollectedFile } from "../core/episodeLabel";
import type { WorkFormatKey } from "../core/workFormat";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 合本（1ファイルに全話）から、どの話を投稿用にコピーするかを選ばせる
 * （設計書6.12.1）。
 *
 * **カーソルの無い入口のためにある。** 原稿エディタと普通のエディタは
 * カーソルの位置でいま居る話が分かるが、作品一覧の「本文をコピー」と
 * 投稿キットはファイルを名指しするだけで、どの話かを知る手立てが無い。
 * 黙って1話目にすると、押した人には**取り違えたことが分からない**。
 */

/** 合本の中の1話に付ける見出し。「第3話　湖畔の誓い」 */
export function collectedEpisodeLabel(
  episode: CollectedEpisode,
  format?: WorkFormatKey
): string {
  /*
    **見出しは作品の数え方を通す**（`collectedChapterLabel`）。
    ここに「第◯話」と直に書くと、SNS記事（「◯本目」）や創作メモ集
    （「メモ◯」）の作品でも、合本のときだけ数え方が変わる。

    話数が読めない話もある（「プロローグ」など）。**並び順で埋めない**
    ——別の話の話数を名乗ることになるので、並び順だと分かる言い方にする。
  */
  const label = collectedChapterLabel(
    { insideCollected: true, chapterStart: episode.chapter },
    `${episode.order}番目`,
    format
  );
  return episode.title ? `${label}　${episode.title}` : label;
}

/**
 * 合本なら、どの話かを選ばせる。
 *
 * @returns 選ばれた話／合本でなければ `null`／取りやめなら `undefined`
 *   （**取りやめと「合本ではない」を混ぜない**。投稿キットは取りやめた
 *   ときに「投稿済み」を記録してはいけない）
 */
export async function pickCollectedEpisode(
  rawText: string,
  format?: WorkFormatKey
): Promise<CollectedEpisode | null | undefined> {
  const episodes = parseCollectedFile(rawText);
  // 1話ぶんに区切り行が付いているだけのファイルは合本ではない
  // （`isCollectedFile`。全ファイルに「合本」の印が付いた失敗がある）
  if (!episodes || !isCollectedFile(episodes.length)) return null;

  const picked = await vscode.window.showQuickPick(
    [
      ...episodes.map((episode) => ({
        label: collectedEpisodeLabel(episode, format),
        // 取り違えにその場で気づけるように、字数と書き出しを添える
        description: `${episode.body.length.toLocaleString("ja-JP")}字`,
        detail: episode.body.trim().slice(0, 40),
        episode,
      })),
      cancelItem(),
    ],
    {
      title: "この本には話がまとめて入っています",
      placeHolder: "どの話をコピーしますか",
      ignoreFocusOut: true,
    }
  );

  if (!picked || isCancelItem(picked) || !("episode" in picked)) {
    return undefined;
  }
  return picked.episode;
}
