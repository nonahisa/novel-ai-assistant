import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { pathExists } from "../core/fileSystem";
import { buildPlotTemplate } from "../core/plotTemplate";
import { manuscriptViewTypeFor } from "../core/manuscriptViewTypes";
import { PLOT_FILE, readWorkConfig, workPaths } from "../core/workRegistry";
import {
  firstEpisodeFileName,
  newEpisodeTemplate,
} from "../core/episodeTemplate";
import {
  WORK_FORMATS,
  type WorkFormatDef,
  type WorkFormatKey,
} from "../core/workFormat";
import { cancelItem, isCancelItem } from "../views/dialogs";
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
 * そのタイプでは、始め方を訊かずに本文から始めるか（設計書6.70）。
 *
 * **創作メモ集にプロットは無い。** 「プロットから始めますか」と訊いても
 * 選びようがなく、選ばせたところで書くのはメモである。訊かずに
 * 最初のメモを開く（形式を書き留めるための `設定/plot.md` だけは作るが、
 * プロットの見出し一式は並べない——`updatePlotMarkdown` は頼まれた節
 * しか書かない）。
 */
export function skipsStartModeQuestion(format?: WorkFormatKey): boolean {
  return format === "memo";
}

/**
 * 作るときにタイプを選んでもらう（設計書6.70）。
 *
 * **選ばなくてもよい。** 「決めない」を選べば、これまでどおり
 * 形式の書かれていない作品として始まる（あとから
 * 「形式とジャンルを決める」で決められる）。
 *
 * @returns 選んだタイプ。「決めない」なら `"unset"`、
 *   取りやめ（Esc）なら `undefined`
 */
export async function chooseWorkType(
  title: string
): Promise<WorkFormatDef | "unset" | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...WORK_FORMATS.map((format) => ({
        label: format.label,
        detail: format.description,
        format: format as WorkFormatDef | undefined,
      })),
      {
        label: "$(circle-slash) いまは決めない",
        detail:
          "あとから「形式とジャンルを決める」で決められます。" +
          "決めるまでは、これまでどおりすべての操作が出ます。",
        format: undefined,
      },
      // **「決めない」とは別の出口。** こちらは作品を作ること自体を取りやめる。
      // Escでも閉じられるが、それを知らない人には出口が無いように見える
      { ...cancelItem(), format: undefined } as never,
    ],
    {
      title: `「${title}」はどんな作品ですか？`,
      placeHolder: "あとから変えられます",
      // 別のウィンドウへ目を移した拍子に消えると、作品名の入力からやり直しになる
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return picked.format ?? "unset";
}

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
  const plotPath = await ensurePlotFile(work);
  // 作者が .md に割り当てたエディターで開く（設計書6.17.6）
  await openInDefaultEditor(plotPath);
}

/**
 * プロットの在り処を返す。無ければテンプレートから作る。
 *
 * **開くところは呼び手に任せる。** プロットモード（設計書6.4.8）は
 * 目次から行へ飛ばすために `TextEditor` の実体を要るので、
 * 割り当て任せの `vscode.open` では受け取れない。作るかどうかの判断だけを
 * ここに置けば、**書きかけのプロットをテンプレートで上書きしない**という
 * 約束は1か所で守られる。
 */
export async function ensurePlotFile(work: WorkEntry): Promise<string> {
  const config = await readWorkConfig(work);
  const settingsDir = workPaths(work, config).settings;
  const plotPath = path.join(settingsDir, PLOT_FILE);

  if (await pathExists(plotPath)) return plotPath;

  await vscode.workspace.fs.createDirectory(path.toUri(settingsDir));
  await vscode.workspace.fs.writeFile(
    path.toUri(plotPath),
    new TextEncoder().encode(buildPlotTemplate(work.title))
  );
  vscode.window.showInformationMessage(
    `「${work.title}」のプロット（${PLOT_FILE}）を作りました。`
  );
  return plotPath;
}

/**
 * 第1話（創作メモ集なら最初のメモ）のファイルを作って開く。
 *
 * ファイル名の付け方は「新規話数ファイルを追加」と同じ決まりに従う
 * （`firstEpisodeFileName`）。最初の1件だけ別の形になると、
 * 話数の解析でつまずくし、2件目と並びが揃わない。
 */
export async function createFirstEpisodeFile(
  work: WorkEntry,
  /**
   * 作ったときだけ呼ぶ。**執筆量の基準を置き直す**ために使う（設計書6.3.2）。
   *
   * 記録は「ファイル数が変わった回は数えない」（投稿サイトからの取り込みを
   * 執筆に数えないため）ので、空の第1話を作ったまま置いておくと、
   * **作者が書いて最初に保存した回がその決まりに当たり、「今日 +0字」に
   * なって以後も数えられない。**
   */
  onCreated?: (work: WorkEntry) => Promise<void>,
  /**
   * 作品のタイプ（設計書6.70）。脚本なら雛形から始め、縦書きで開く。
   * 決めていなければ、これまでどおり空のファイルを横書きで開く。
   */
  format?: WorkFormatKey
): Promise<string | undefined> {
  const config = await readWorkConfig(work);
  const p = workPaths(work, config);
  // 本文フォルダーを持たない形で登録された作品では作品ルートへ置く
  const manuscriptDir = (await pathExists(p.manuscript)) ? p.manuscript : p.root;

  const settings = vscode.workspace.getConfiguration("novelai");
  const filePath = path.join(
    manuscriptDir,
    firstEpisodeFileName(format, {
      digits: settings.get<number>("episodeNumberDigits", 3),
      extension: settings.get<string>("episodeFileExtension", ".txt"),
    })
  );

  // 既にあるなら作らずに開く。中身を消してはいけない
  if (!(await pathExists(filePath))) {
    await vscode.workspace.fs.writeFile(
      path.toUri(filePath),
      // 脚本だけは形（柱・ト書き・セリフ）を置いておく（設計書6.70）
      new TextEncoder().encode(newEpisodeTemplate(format))
    );
    // 作ったときだけ基準を置き直す。既にあったなら、記録はもう追えている
    await onCreated?.(work);
  }

  // **本文は原稿エディタで開く**（作者の指定、2026-08-29。作品一覧の
  // クリックと同じ既定に揃える）。向きはタイプで決まる（脚本だけ縦書き）
  await vscode.commands.executeCommand(
    "vscode.openWith",
    path.toUri(filePath),
    manuscriptViewTypeFor(format)
  );
  return filePath;
}
