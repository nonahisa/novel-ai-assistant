import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { extractEpisodeParts, nameWithSubtitle } from "../core/episodeCopy";
import { convertForPosting } from "../core/postingConvert";
import { showPostingCopyNotice } from "./postingCopyNotice";
import { readTextFile } from "../core/textFile";
// 貼り付け先を訊く画面は1つにする（写すと、片方だけ選べる先が増える）
import { pickPostingTarget } from "./ruby";
import { registeredPostingSites } from "./postingCopyRegistered";
import { recordEdit } from "../core/actorContext";
import { logFailure, useLogFile } from "../core/logger";
import { formatChapterLabel, stripChapterLabel } from "../core/episodeLabel";
import { notifyDone } from "../views/notify";

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
  notifyDone(
    `「${parts.subtitle}」をコピーしました。`
  );
}

/**
 * 本文を、投稿サイトの形にしてクリップボードへ。
 *
 * **原稿には触らない。** 貼り付ける先はサイトの投稿欄であって、
 * 手元の原稿を投稿サイト記法へ変えてしまうと次に書くときに困る（6.12.1）。
 */
export async function copyBodyForPosting(
  /** 登録してある投稿先を先頭に出すために要る（設計書6.68.2） */
  work: WorkEntry,
  episode: EpisodeFile
): Promise<void> {
  const parts = await read(episode);
  if (!parts) return;

  /*
    **訊くのは貼り付け先だけ。1度だけ**（設計書6.12.4）。

    以前は「どの形で書き出すか（記法）」を訊いてから、傍点が入っている
    ときだけ「どのサイトへ貼るか」を訊く2段だった。1段目は記法を訊いて
    おり、作者は自分の貼り付け先がどの記法に当たるのかを逆算させられて
    いた。**サイトが決まれば記法は決まる**（`POSTING_SITES`）。
    傍点の有無で訊く回数が変わるのも、作者からは「なぜ今日は2回訊かれる
    のか」が分からない。
  */
  const target = await pickPostingTarget(await registeredPostingSites(work));
  if (!target) return;

  // 貼り付け先ごとの分岐は変換の側にある（`convertForPosting`、設計書6.84）
  // ——noteはMarkdownをそのまま解釈するので、記法の置き換えだけでは足りない
  // **1話まるごとなので、前後の空行は落とす**（設計書6.84）。ヘッダーを
  // 外した本文はその直後の空行から始まることが多く、そのまま貼ると
  // 投稿欄の1行目が空いた状態で公開される
  const conversion = convertForPosting(parts.body, target, {
    trimEdges: true,
  });
  if (!conversion.text) {
    void vscode.window.showWarningMessage(
      `${episode.fileName} に本文が見つかりませんでした。`
    );
    return;
  }

  await vscode.env.clipboard.writeText(conversion.text);
  await showPostingCopyNotice({
    conversion,
    sourcePath: episode.filePath,
    otherwise: () =>
      void vscode.window.showInformationMessage(
        `本文（${conversion.text.length.toLocaleString("ja-JP")}字）を` +
          `${target.label}の書き方でコピーしました。原稿はそのままです。`
      ),
  });
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
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
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
  notifyDone(`${next} に変えました。`);
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
