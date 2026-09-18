import * as vscode from "vscode";
import * as path from "../core/paths";
import {
  DEFAULT_LIBRARY_NAME,
  decideNewWorkHome,
  describeNewWorkHome,
  type LibraryCandidate,
  type WorkLocation,
} from "../core/libraryHome";
import { scanCollection } from "../core/workCollection";
import { withProgress } from "../views/progress";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { pickFolder } from "./pickFolder";

/**
 * 新しい作品を作る場所を決める画面（設計書6.97.2）。
 *
 * 判断そのものは `core/libraryHome.ts` にある。ここは**画面を出すところ
 * だけ**を受け持つ——フォルダー選択、書庫が分かれているときの選択画面、
 * そして「まだ書庫が無いときに書庫を1つ作る」の組み立てである。
 *
 * **作者に「書庫を作りますか」とは訊かない。** 訊く代わりに、決まった
 * 行き先を一行で伝える（`describeNewWorkHome`）。
 */

export interface NewWorkHome {
  /** 作品フォルダーを作る親（＝書庫）。まだ無い場合もある（作るのは呼び出し側） */
  readonly folderPath: string;
  /** 作者に見せる一行の説明 */
  readonly note: string;
}

/** ほかの場所を選びたいときの逃げ道。選択肢の中に見えている形にする */
const ELSEWHERE = "__elsewhere__";

export async function resolveNewWorkHome(
  works: readonly WorkLocation[]
): Promise<NewWorkHome | undefined> {
  const decided = decideNewWorkHome(works);

  if (decided.kind === "library") {
    return {
      folderPath: decided.folderPath,
      note: describeNewWorkHome(decided.folderPath),
    };
  }

  if (decided.kind === "choose") {
    const picked = await chooseLibrary(decided.candidates);
    if (picked === undefined) return undefined;
    if (picked !== ELSEWHERE) {
      return { folderPath: picked, note: describeNewWorkHome(picked) };
    }
  }

  return createLibraryHome();
}

/**
 * 書庫が分かれているときだけ出す選択画面。
 *
 * **作品の多い順に並べる**（`findLibraries` がそう返す）。ふだん使って
 * いる書庫が先頭に来るので、たいていは先頭を押せば済む。
 */
async function chooseLibrary(
  candidates: readonly LibraryCandidate[]
): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...candidates.map((candidate) => ({
        label: `$(library) ${path.basename(candidate.folderPath)}`,
        description: `${candidate.workCount}作品`,
        detail: candidate.folderPath,
        home: candidate.folderPath,
      })),
      {
        label: "$(folder) ほかの場所にする",
        detail: "作品を置く場所を、あらためて選びます",
        home: ELSEWHERE,
      },
      cancelItem(),
    ],
    {
      title: "どこに作りますか",
      placeHolder: "すでに作品を置いてあるフォルダーが分かれています",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("home" in picked)) return undefined;
  return picked.home;
}

/**
 * まだ書庫が無いとき、作る場所を決める。
 *
 * **選んでもらったフォルダーに、すでに作品が並んでいれば、そこが書庫である。**
 * その中にもう1階層こしらえると、作者の見慣れた並びを崩してしまう
 * （既存資産のある人が、ここへ来る）。
 *
 * 並んでいなければ、選んでもらった場所の中に書庫を1つ作る。**作るのは
 * 作品フォルダーを作るときで、ここでは場所を決めるだけ**——途中で
 * 取りやめられたときに、空のフォルダーだけが残らないようにするため。
 */
async function createLibraryHome(): Promise<NewWorkHome | undefined> {
  const parentPath = await pickFolder(
    "作品を置く場所を選択",
    "ここに作品を置く"
  );
  if (!parentPath) return undefined;

  const scan = await withProgress("フォルダーの中を見ています…", () =>
    scanCollection(parentPath, () => false)
  );

  if (scan.kind === "single_work") {
    // **作品の中に作品は作れない。** ここで黙って進むと、入れ子の
    // おかしな並びができあがる
    await vscode.window.showWarningMessage(
      `「${path.basename(parentPath)}」は作品そのもののようです。`,
      {
        modal: true,
        detail: [
          "作品フォルダーの中に、別の作品を作ることはできません。",
          "",
          "ひとつ上のフォルダーを選び直してください。",
        ].join("\n"),
      }
    );
    return undefined;
  }

  if (scan.kind === "collection" || scan.kind === "work_with_children") {
    return { folderPath: parentPath, note: describeNewWorkHome(parentPath) };
  }

  const library = path.join(parentPath, DEFAULT_LIBRARY_NAME);
  return { folderPath: library, note: describeNewWorkHome(library) };
}
