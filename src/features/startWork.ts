import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { formatChapterNumber } from "../core/episodeParser";
import { pathExists } from "../core/fileSystem";
import { buildPlotTemplate } from "../core/plotTemplate";
import { PLOT_FILE, readWorkConfig, workPaths } from "../core/workRegistry";
import { cancelItem } from "../views/dialogs";
import { openInDefaultEditor } from "../views/openDocument";

/**
 * 新規作品の始め方（設計書6.4）。
 *
 * **プロットを立ててから書く作者と、書きながら考える作者がいる。**
 * どちらかに決めつけると、片方には要らないファイルが増え、
 * もう片方には最初の一歩が見えない。作るときに選んでもらう。
 *
 * 選ばなかったほうへは、あとからでも移れる。プロットは
 * 「プロットをつくる」で足せるし、本文は「新規話数ファイルを追加」で作れる。
 */

export type WorkStartMode = "plot" | "manuscript";

/**
 * 始め方を選んでもらう。取り消したら undefined。
 *
 * **作品フォルダーを作る前に訊く。** 作ったあとで取り消されると、
 * 中身の無いフォルダーだけが残る。
 */
export async function chooseWorkStartMode(
  title: string
): Promise<WorkStartMode | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(list-tree) プロットから始める",
        detail:
          "設定/plot.md に、ログライン・テーマ・世界観・あらすじなどの" +
          "見出しを用意して開きます。",
        mode: "plot" as const,
      },
      {
        label: "$(edit) 本文から書き始める",
        detail:
          "プロットは作りません。第1話のファイルを作って開きます。" +
          "プロットはあとから「プロットをつくる」で足せます。",
        mode: "manuscript" as const,
      },
      // Escでも閉じられるが、それを知らない人には出口が無いように見える
      cancelItem(),
    ],
    {
      title: `「${title}」をどこから始めますか？`,
      placeHolder: "あとからどちらへも移れます",
      // 別のウィンドウへ目を移した拍子に消えると、作品名の入力からやり直しになる
      ignoreFocusOut: true,
    }
  );
  if (!picked || !("mode" in picked)) return undefined;
  return picked.mode;
}

/**
 * プロットを開く。無ければテンプレートから作る。
 *
 * 既にあるファイルには触れない。書きかけのプロットをテンプレートで
 * 上書きしては、作者の作業が消えてしまう。
 */
export async function openPlotFile(work: WorkEntry): Promise<void> {
  const config = await readWorkConfig(work);
  const settingsDir = workPaths(work, config).settings;
  const plotPath = path.join(settingsDir, PLOT_FILE);

  const existed = await pathExists(plotPath);
  if (!existed) {
    await vscode.workspace.fs.createDirectory(path.toUri(settingsDir));
    await vscode.workspace.fs.writeFile(
      path.toUri(plotPath),
      new TextEncoder().encode(buildPlotTemplate(work.title))
    );
  }

  // 作者が .md に割り当てたエディターで開く（設計書6.17.6）
  await openInDefaultEditor(plotPath);
  if (!existed) {
    vscode.window.showInformationMessage(
      `「${work.title}」のプロット（${PLOT_FILE}）を作りました。`
    );
  }
}

/**
 * 第1話のファイルを作って開く。
 *
 * ファイル名の付け方は「新規話数ファイルを追加」と同じ設定に従う。
 * 最初の1話だけ別の形になると、話数の解析でつまずく。
 */
export async function createFirstEpisodeFile(
  work: WorkEntry
): Promise<string | undefined> {
  const config = await readWorkConfig(work);
  const p = workPaths(work, config);
  // 本文フォルダーを持たない形で登録された作品では作品ルートへ置く
  const manuscriptDir = (await pathExists(p.manuscript)) ? p.manuscript : p.root;

  const settings = vscode.workspace.getConfiguration("novelai");
  const digits = settings.get<number>("episodeNumberDigits", 3);
  const extension = settings.get<string>("episodeFileExtension", ".txt");
  const filePath = path.join(
    manuscriptDir,
    `${formatChapterNumber(1, digits)}${extension}`
  );

  // 既にあるなら作らずに開く。中身を消してはいけない
  if (!(await pathExists(filePath))) {
    await vscode.workspace.fs.writeFile(
      path.toUri(filePath),
      new TextEncoder().encode("")
    );
  }

  await openInDefaultEditor(filePath);
  return filePath;
}
