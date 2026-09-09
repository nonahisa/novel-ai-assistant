import * as vscode from "vscode";
import * as path from "../core/paths";
import { noteCopyMessage, type PostingConversion } from "../core/postingConvert";
import { pathExists } from "../core/fileSystem";
import { revealFolder } from "../views/openDocument";
import { notifyDone } from "../views/notify";

/**
 * 「投稿サイト用に変換してコピー」のあとの知らせ（設計書6.84）。
 *
 * **noteだけ、言うことが増える。** noteの本文欄はMarkdownをそのまま
 * 解釈するが、**題名・目次・画像は貼り付けでは入らない**。そこを黙って
 * いると、貼ったあとで「画像が消えた」と探すことになる。
 *
 * 件数と次の操作（ボタン）を伴うので、**ステータスバーではなく通知**で出す
 * （設計書6.81の規則3）。ほかの3サイトはこれまでどおりで、
 * **文言も出し方も変えない**——覚えている言葉を一緒に変えない。
 */
export async function showPostingCopyNotice(input: {
  conversion: PostingConversion;
  /** note以外のときの知らせ。入口ごとの文言をそのまま使う */
  otherwise: () => void;
  /**
   * コピー元のファイルの場所。**画像の在り処を組み立てるために要る**
   * （本文に書いてあるのは、たいてい相対パス）。分からなければ渡さない
   */
  sourcePath?: string;
}): Promise<void> {
  const note = input.conversion.note;
  if (!note) {
    input.otherwise();
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

  const picked = await vscode.window.showInformationMessage(
    noteCopyMessage(note, input.conversion.text.length),
    ...buttons
  );

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
  }
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
