import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import {
  bodyForPosting,
  extractEpisodeParts,
  nameWithSubtitle,
  needsEmphasisSite,
} from "../core/episodeCopy";
import { readTextFile } from "../core/textFile";
import { RUBY_STYLES, type EmphasisSite, type RubyStyle } from "../core/ruby";
// 貼り付け先を訊く画面は1つにする（写すと、片方だけ選べる先が増える）
import { pickEmphasisSite } from "./ruby";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { recordEdit } from "../core/actorContext";
import { logFailure } from "../core/logger";
import { formatChapterLabel, stripChapterLabel } from "../core/episodeLabel";

/**
 * 話のサブタイトル・本文をコピーする／ファイル名にサブタイトルを付ける
 * （設計書6.2.3）。
 *
 * **投稿するときの手作業を減らす。** 投稿欄はサブタイトルと本文が別々の
 * 入力になっている。毎話、ファイルを開いてヘッダーを避けて本文を選んで、
 * ルビを書き換えて……を繰り返すのは、書く時間を削る。
 */

/** サブタイトルだけをクリップボードへ */
export async function copySubtitle(episode: EpisodeFile): Promise<void> {
  const parts = await read(episode);
  if (!parts) return;

  if (!parts.subtitle) {
    void vscode.window.showWarningMessage(
      `${episode.fileName} からサブタイトルを読み取れませんでした。` +
        "ファイルの中の【タイトル】か、ファイル名から読み取ります。"
    );
    return;
  }
  await vscode.env.clipboard.writeText(parts.subtitle);
  void vscode.window.showInformationMessage(
    `「${parts.subtitle}」をコピーしました。`
  );
}

/**
 * 本文を、投稿サイトの形にしてクリップボードへ。
 *
 * **原稿には触らない。** 貼り付ける先はサイトの投稿欄であって、
 * 手元の原稿を投稿サイト記法へ変えてしまうと次に書くときに困る（6.12.1）。
 */
export async function copyBodyForPosting(episode: EpisodeFile): Promise<void> {
  const parts = await read(episode);
  if (!parts) return;

  const style = await pickStyle();
  if (!style) return;

  /*
    **傍点が入っているときだけ、貼り付け先を訊く**（設計書6.12.4）。

    ここは長らくカクヨム記法で固定されており、なろう・アルファポリスへ
    貼ると `《《大事》》` がそのまま読者に見えていた（0.30.7で修正）。
    ルビはどのサイトでも同じ書き方なので、傍点が無ければ訊かない。
  */
  let site: EmphasisSite = "kakuyomu";
  if (needsEmphasisSite(parts.body, style.id)) {
    const picked = await pickEmphasisSite();
    if (!picked) return;
    site = picked;
  }

  const text = bodyForPosting(parts.body, style.id, site);
  if (!text) {
    void vscode.window.showWarningMessage(
      `${episode.fileName} に本文が見つかりませんでした。`
    );
    return;
  }

  await vscode.env.clipboard.writeText(text);
  void vscode.window.showInformationMessage(
    `本文（${text.length.toLocaleString("ja-JP")}字）を${style.label}で` +
      "コピーしました。原稿はそのままです。"
  );
}

/**
 * ファイル名にサブタイトルを付ける。
 *
 * **話数の部分は変えない。** そこは並び順を決めており、変えると
 * 作品の順序が崩れる。後ろに足すだけにする。
 */
export async function renameWithSubtitle(
  work: WorkEntry,
  episode: EpisodeFile
): Promise<void> {
  const parts = await read(episode);
  if (!parts) return;

  // **題から話数を落としてから足す。** 投稿サイトのヘッダーには
  // 「第15話　イジメっ子襲撃」と話数込みで入っている。そのまま足すと
  // `episode_0015_第15話　イジメっ子襲撃.txt` になり、**話数が二重になる**
  // （2026-08-21、作者の指摘）。一覧の見出しは既に `stripChapterLabel` を
  // 通しているのに、ここだけ通っていなかった
  const subtitle = stripChapterLabel(
    parts.subtitle,
    formatChapterLabel(episode)
  );

  const next = nameWithSubtitle(episode.fileName, episode.subtitle, subtitle);
  if (!next) {
    void vscode.window.showInformationMessage(
      subtitle
        ? `${episode.fileName} には既にサブタイトルが付いています。`
        : `${episode.fileName} からサブタイトルを読み取れませんでした（題が話数だけのようです）。`
    );
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    "ファイル名を変えます。",
    {
      modal: true,
      detail:
        `${episode.fileName}\n  ↓\n${next}\n\n` +
        "中身は変えません。名前だけです。\n" +
        "話数の部分（並び順を決めている部分）はそのまま残します。",
    },
    "変える"
  );
  if (answer !== "変える") return;

  const target = path.join(path.dirname(episode.filePath), next);
  try {
    // **上書きしない。** 同じ名前があれば失敗させる
    await vscode.workspace.fs.rename(
      path.toUri(episode.filePath),
      path.toUri(target),
      { overwrite: false }
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `名前を変えられませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    logFailure("サブタイトルを付けた改名に失敗", {
      ファイル: episode.fileName,
      新しい名前: next,
    });
    return;
  }

  await recordEdit(work, {
    actor: "author",
    action: "ファイル名にサブタイトルを付けた",
    file: episode.fileName,
    detail: next,
  });
  void vscode.window.showInformationMessage(`${next} に変えました。`);
}

async function read(
  episode: EpisodeFile
): Promise<{ subtitle: string | null; body: string } | undefined> {
  try {
    const file = await readTextFile(episode.filePath);
    return extractEpisodeParts(file.text, episode.subtitle);
  } catch {
    void vscode.window.showErrorMessage(
      `${episode.fileName} を読み込めませんでした。`
    );
    return undefined;
  }
}

async function pickStyle(): Promise<RubyStyle | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...RUBY_STYLES.map((style) => ({
        label: style.label,
        detail: style.detail,
        style,
      })),
      cancelItem(),
    ],
    {
      title: "どの形でコピーしますか",
      placeHolder: "投稿する先に合わせて選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "style" in picked ? picked.style : undefined;
}
