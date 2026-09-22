import * as vscode from "vscode";
import * as path from "../core/paths";
import { noteCopyMessage, type PostingConversion } from "../core/postingConvert";
import { pathExists } from "../core/fileSystem";
import { logFailure, useLogFile } from "../core/logger";
import { postingSiteInfo, type PostingSiteId } from "../models/posting";
import type { WorkEntry } from "../models/types";
import { revealFolder } from "../views/openDocument";
import { notifyDone } from "../views/notify";
import { postingPageUrlFor } from "./postingCopyRegistered";

/**
 * 「投稿サイト用に変換してコピー」のあとの知らせ（設計書6.84）。
 *
 * **noteだけ、言うことが増える。** noteの本文欄はMarkdownをそのまま
 * 解釈するが、**題名・目次・画像は貼り付けでは入らない**。そこを黙って
 * いると、貼ったあとで「画像が消えた」と探すことになる。
 *
 * **投稿ページを開くボタンを添える**（作者の依頼、2026-09-23）。コピーの
 * 次にすることは、そのサイトの投稿欄を開いて貼ることだからである。
 * URLの決め方は `core/postingSiteUrls.ts` の `postingPageUrl`（台帳の値、
 * 無ければ形の確かなサイトだけ組み立てる）。**押したときだけ開く**——
 * 勝手に開かないし、投稿サイトへは何も書き込まない（6.68.1）。
 *
 * 件数と次の操作（ボタン）を伴うので、**ボタンがあるときは通知**で出す
 * （設計書6.81の規則3）。ボタンが1つも無いほかの3サイトはこれまでどおりで、
 * **文言も出し方も変えない**——覚えている言葉を一緒に変えない。
 *
 * **押されるのを待たずに戻る。** ボタン付きの通知は、閉じられるまで
 * 返事が来ない（通知センターへ沈んだだけでは来ない）。待つと、コピーを
 * 「済んだ」と数える側（画面で指しながらの案内、設計書6.104）が、
 * 作者が通知を閉じるまで止まる。
 */
export async function showPostingCopyNotice(input: {
  conversion: PostingConversion;
  /** note以外のときの知らせの文。入口ごとの文言をそのまま使う */
  summary: string;
  /**
   * ボタンが1つも無いときの出し方。既定はステータスバー（`notifyDone`）。
   * **作品一覧の右クリックだけは、以前から通知で出していた**ので `"popup"`
   * ——出し方を入口ごとに変えないまま、ここへ寄せる
   */
  withoutButtons?: "status" | "popup";
  /**
   * コピー元のファイルの場所。**画像の在り処を組み立てるために要る**
   * （本文に書いてあるのは、たいてい相対パス）。分からなければ渡さない
   */
  sourcePath?: string;
  /** 貼り付け先のサイト。記法だけで決まる書き出し先（別記法・HTML）には無い */
  site?: PostingSiteId;
  /** 台帳を読むための作品。引けなければ渡さない（ボタンが出ないだけ） */
  work?: WorkEntry;
}): Promise<void> {
  const pageUrl = await postingPageUrlFor(input.work, input.site);
  const openPage =
    pageUrl && input.site
      ? `${postingSiteInfo(input.site).label}の投稿ページを開く`
      : undefined;

  const note = input.conversion.note;
  if (!note) {
    if (!openPage) {
      if (input.withoutButtons === "popup") {
        void vscode.window.showInformationMessage(input.summary);
      } else {
        notifyDone(input.summary);
      }
      return;
    }
    whenPicked(
      input.work,
      vscode.window.showInformationMessage(input.summary, openPage),
      async (picked) => {
        if (picked === openPage && pageUrl) await openPostingPage(pageUrl);
      }
    );
    return;
  }

  const copyTitle = "題名をコピー";
  const openImages = "画像のフォルダーを開く";
  const imagePath = await firstImagePath(
    input.sourcePath,
    note.images[0]?.path
  );

  const buttons: string[] = [];
  if (note.title) buttons.push(copyTitle);
  if (imagePath) buttons.push(openImages);
  // 題名・画像のあとに並べる。noteで先に要るのは、貼ったあとの手当てのほう
  if (openPage) buttons.push(openPage);

  whenPicked(
    input.work,
    vscode.window.showInformationMessage(
      noteCopyMessage(note, input.conversion.text.length),
      ...buttons
    ),
    async (picked) => {
      if (picked === copyTitle && note.title) {
        // **本文を上書きする。** 題名欄へ入れるのは本文を貼ったあとなので、
        // ここで持ち替えるのがいちばん手数が少ない
        await vscode.env.clipboard.writeText(note.title);
        notifyDone(`題名「${note.title}」をクリップボードへ入れました。`);
        return;
      }
      if (picked === openImages && imagePath) {
        // ドラッグ＆ドロップでnoteへ上げられるように、置き場所を見せる
        await revealFolder(imagePath);
        return;
      }
      if (picked === openPage && pageUrl) await openPostingPage(pageUrl);
    }
  );
}

/**
 * 通知のボタンが押されたら動かす。**押されるのを待たない**（上の説明）。
 *
 * 待たない代わりに、**失敗を握りつぶさない**。呼んだ側はもう戻っているので、
 * ここで記録して作者に伝える。
 */
function whenPicked(
  /** 記録の書き先（作品のログファイル）。引けなければ既定の場所へ */
  work: WorkEntry | undefined,
  shown: Thenable<string | undefined>,
  act: (picked: string | undefined) => Promise<void>
): void {
  void Promise.resolve(shown)
    .then(act)
    .catch((error: unknown) => {
      // **記録の直前に書き先を向ける**（postingCopyRegistered.ts と同じ）
      useLogFile(work?.folderPath);
      logFailure("投稿サイト用のコピー：知らせのボタン", {
        work: work?.title,
        error,
      });
      void vscode.window.showWarningMessage(
        "ボタンの操作をやり遂げられませんでした。詳しくはログを見てください。"
      );
    });
}

/**
 * 投稿ページを開く。**既定のブラウザ**で開く（特定のブラウザを決め打ちしない）。
 *
 * **開くだけ。** ページの中身は読まないし、貼り付けも投稿も作者がする（6.68.1）。
 */
async function openPostingPage(url: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Windowsの絶対パス（`C:\…`）。**URLの仕組み（scheme）と見分ける** */
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;

/**
 * 本文に書いてある画像の在り処を、実際の場所へ。
 *
 * **外のURLは開かない。** 手元にファイルが無いので、開いても空振りする。
 * ただし `C:\画像\cat.png` は**URLではない**——`C:` を仕組み（scheme）と
 * 読んでいたころは、手元にある画像を「外のもの」として断っていた。
 * ドライブレターを先に見分ける。
 *
 * **実在しないものは返さない。** 本文のパスが間違っている・画像をまだ
 * 用意していないことはふつうにあり、そのときボタンを出しても空振りする
 * ——押しても何も起きないボタンは、作者には壊れたようにしか見えない。
 */
async function firstImagePath(
  sourcePath: string | undefined,
  written: string | undefined
): Promise<string | undefined> {
  if (!sourcePath || !written) return undefined;
  if (!DRIVE_LETTER.test(written) && /^[a-z][a-z0-9+.-]*:/i.test(written)) {
    return undefined;
  }

  const candidate = path.isAbsolute(written)
    ? written
    : path.join(path.dirname(sourcePath), written);
  try {
    return (await pathExists(candidate)) ? candidate : undefined;
  } catch {
    // 権限や一時的な障害で確かめられないだけなら、出口は残す
    return candidate;
  }
}
