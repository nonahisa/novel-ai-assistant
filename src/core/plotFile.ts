import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { PLOT_FILE, readWorkConfig, workPaths } from "./workRegistry";
import { atomicWriteFile, createManagedRecoveryPath } from "./atomicWrite";
import { updatePlotMarkdown, type PlotSections } from "./plotDoc";
import { readTextFile } from "./textFile";
import {
  describePreferOpenDocumentFailure,
  writeTextFilePreferringOpenDocument,
} from "./openDocumentEdit";

/**
 * プロット（`設定/plot.md`）の読み書き。
 *
 * **同じ処理が `generatePlot.ts` と `applyChatEdit.ts` に別々にあった。**
 * 3か所目（形式・ジャンルの選択）を作るところで1つにまとめた。
 * 別々に持つと、片方だけ直したときに書き方が食い違う。
 */

export async function plotPath(work: WorkEntry): Promise<string> {
  const config = await readWorkConfig(work);
  return path.join(workPaths(work, config).settings, PLOT_FILE);
}

/** ファイルの中身をそのまま読む。無ければ空文字 */
export async function readPlotText(work: WorkEntry): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(await plotPath(work))
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/**
 * 節を書き足す。
 *
 * **作者の文書の形を変えない**（`updatePlotMarkdown`）。
 * 既存ファイルは上書きできない（`atomicWrite.ts`）ので、
 * 元の内容を回復先へ退避してから作り直す。作者の文書なので、
 * 失敗しても元が残るようにしておく。
 */
export async function writePlotSections(
  work: WorkEntry,
  updates: Partial<PlotSections>
): Promise<void> {
  await rewritePlotFile(await plotPath(work), (current) =>
    updatePlotMarkdown(current, updates, { workTitle: work.title })
  );
}

/**
 * plot.md を、今の中身から作り直した中身へ書き換える。書き換えたら true。
 *
 * **エディターで開いていれば、その文書へ当てて保存する**（`writeTextFilePreferringOpenDocument`）。
 * ディスクを「退避 → 消して作り直す」で書くと、開いたままのエディターが読み直す前に作者が打ったとき
 * Ctrl+S が「ファイルのほうが新しい」で断られた（0.107.8、作者の裁定「両方直す」）。
 * 開いていなければ本文と同じ書き戻しの口でディスクへ書く（読み込み時のハッシュ照合・
 * 文字コードと改行の保持・退避つき）。**未保存の変更があれば書かずに止める**——
 * これまでの `writePlotText` は確かめずに書いていたので、書きかけの分を巻き込みえた。
 *
 * 書けなければ投げる（文は作者に見せられる形）。ファイルが無ければ作る（`update("")` が空なら作らない）。
 *
 * @param update 今の中身（LF空間）から書きたい中身（LF空間）を作る
 */
export async function rewritePlotFile(
  target: string,
  update: (current: string) => string
): Promise<boolean> {
  return rewriteMarkdownFile(target, update, PLOT_LABEL);
}

/** 断りの文で使う plot.md の呼び名（AIを呼ぶ前の確かめと、書く口とで同じ言葉にする） */
export const PLOT_LABEL = "プロット（plot.md）";

/**
 * 作者が開いていそうな `設定/` の Markdown（plot.md・synopsis.md）を書き換える口。中身は
 * `rewritePlotFile` の説明のとおり（開いていれば文書へ当てて保存・未保存なら止める・ハッシュ照合）。
 *
 * synopsis.md も、相談パネル（`applyChatEdit.ts`）と名前の付け替え（`nameRename.ts`）が
 * それぞれ「退避 → 消して作り直す」を**ハッシュの照合も未保存の確かめもせず**に書いていた。
 * 開いたまま書きかけていれば巻き込むか、Ctrl+S が「ファイルのほうが新しい」で断られる。
 * plot.md と同じ事故なので、同じ口へ揃えた。
 *
 * @param label 断りの文に出す、作者が見て分かる呼び名（例「プロット（plot.md）」）
 */
export async function rewriteMarkdownFile(
  target: string,
  update: (current: string) => string,
  label: string
): Promise<boolean> {
  if (!(await exists(target))) {
    const body = update("");
    if (body === "") return false;
    await writePlotText(target, body);
    return true;
  }
  const file = await readTextFile(target);
  const result = await writeTextFilePreferringOpenDocument(target, file, update(file.text));
  const failure = describePreferOpenDocumentFailure(result, label);
  if (failure) throw new Error(failure);
  return result.ok && result.via !== "unchanged";
}

/**
 * 退避してから作り直す（無ければ作る）。**こちらはハッシュ照合も未保存の確かめも、開いている
 * 文書への当て込みもしない。** 既にある plot.md を書き換えるときは `rewritePlotFile` を通す。
 * 残っている呼び手は、新しく作るとき（`rewriteMarkdownFile`）と、開いていないと確かめたあと
 * （プロットモードの見出しを足す口）だけ
 */
export async function writePlotText(
  target: string,
  body: string
): Promise<void> {
  await vscode.workspace.fs.createDirectory(
    path.toUri(path.dirname(target))
  );

  if (await exists(target)) {
    const recoveryPath = await createManagedRecoveryPath(target);
    const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    await atomicWriteFile(recoveryPath, bytes, { mode: "create" });
    await vscode.workspace.fs.delete(path.toUri(target), {
      useTrash: false,
    });
  }

  await atomicWriteFile(target, new TextEncoder().encode(body), {
    mode: "create",
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(filePath));
    return true;
  } catch {
    return false;
  }
}
