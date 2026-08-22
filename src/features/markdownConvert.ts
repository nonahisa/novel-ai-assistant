import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import {
  describeRefusal,
  isPlainTextManuscript,
  planConversion,
  planFolderConversion,
  type ConversionPlan,
} from "../core/markdownConversion";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { pathExists } from "../core/fileSystem";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 本文の `.txt` を `.md` にする（設計書6.12.1）。
 *
 * **中身は1文字も変えない。名前だけを変える。** 文字コードも改行も、
 * 書いた本文もそのまま残る。Markdownとして書き換えると（見出しを付ける、
 * 空行を詰めるなど）、それは原稿の改変になる。
 *
 * ## 入口を独立させた理由
 *
 * **もとは「ルビを振る」を押したときにだけ現れる救済の道だった。**
 * `.txt` でルビを使おうとした作者へ「ルビは .md でしか使えません」と
 * 断ったうえで、その場で変換を申し出る形である。
 *
 * **しかしMD化したい理由はルビだけではない**（プレビューで読みたい、
 * 見出しを使いたい）。作者から「どこから操作すればいいのでしょうか？」と
 * 訊かれた（2026-08-22）——**機能はあるのに辿り着けない**、
 * GitHubへ載せる入口と同じ形の抜けだった（5.7.9）。
 */

/** 同じフォルダーにある名前の一覧（拡張子込み） */
export async function siblingNames(filePath: string): Promise<string[]> {
  const dir = path.toUri(path.dirname(filePath));
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([, kind]) => kind === vscode.FileType.File)
      .map(([name]) => name);
  } catch {
    return [];
  }
}

/** 1件だけ変換する。変換後のパスを返す */
export async function convertOne(
  filePath: string
): Promise<string | undefined> {
  const decision = planConversion(filePath, await siblingNames(filePath));
  if (!decision.plan) {
    void vscode.window.showErrorMessage(
      `変換できませんでした。${describeRefusal(decision.refusal!)}`
    );
    return undefined;
  }
  try {
    await renamePreservingContent(decision.plan);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `変換できませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
  void vscode.window.showInformationMessage(
    `${path.basename(filePath)} を ${path.basename(decision.plan.to)} にしました。`
  );
  return decision.plan.to;
}

/** フォルダーの .txt をまとめて変換する。もとのファイルに当たる変換後のパスを返す */
export async function convertFolder(
  filePath: string
): Promise<string | undefined> {
  const dir = path.dirname(filePath);
  const names = await siblingNames(filePath);
  const targets = names
    .filter((name) => isPlainTextManuscript(name))
    .map((name) => path.join(dir, name))
    .sort();

  const { plans, skipped } = planFolderConversion(targets, names);
  if (plans.length === 0) {
    void vscode.window.showWarningMessage("変換できる .txt がありませんでした。");
    return undefined;
  }

  const done: string[] = [];
  const failed: string[] = [];
  for (const plan of plans) {
    try {
      await renamePreservingContent(plan);
      done.push(plan.to);
    } catch (error) {
      // **1件失敗しても残りは進める。** 途中で止めると、
      // どこまで終わったのかが作者に分からない
      failed.push(
        `${path.basename(plan.from)}（${
          error instanceof Error ? error.message : String(error)
        }）`
      );
    }
  }

  const notes = [`${done.length}件を .md にしました。`];
  if (skipped.length > 0) {
    notes.push(
      `${skipped.length}件は見送りました：` +
        skipped
          .map(
            (entry) =>
              `${path.basename(entry.file)}（${describeRefusal(entry.refusal)}）`
          )
          .join("、")
    );
  }
  if (failed.length > 0) {
    notes.push(`${failed.length}件は失敗：${failed.join("、")}`);
  }
  void vscode.window.showInformationMessage(notes.join(" "));

  const mine = plans.find((plan) => plan.from === filePath);
  return mine?.to ?? done[0];
}

/**
 * 名前だけを変える。
 *
 * **中身を読み書きしない。** 読んで書き直すと、文字コードや改行の
 * 扱いを1つ間違えただけで原稿が壊れる。名前を変えるだけなら、
 * 中身に触れる余地がそもそも無い。
 */
export async function renamePreservingContent(
  plan: ConversionPlan
): Promise<void> {
  await vscode.workspace.fs.rename(path.toUri(plan.from), path.toUri(plan.to), {
    // **上書きしない。** 既にあるなら planConversion が止めているが、
    // その後に作られている場合もある
    overwrite: false,
  });
}

/**
 * 操作メニューから呼ぶ。**何を対象にするかを、まず決める。**
 *
 * ファイルを右クリックしたときは対象が決まっているので訊かない
 * （`convertOne` を直に呼ぶ）。メニューから押したときは、いま開いている
 * 1件なのか本文まるごとなのかが分からないので、そこだけ選んでもらう。
 */
export async function convertToMarkdown(work: WorkEntry): Promise<boolean> {
  const active = vscode.window.activeTextEditor;
  const activePath = active ? fromUri(active.document.uri) : undefined;
  const activeIsText = activePath
    ? isPlainTextManuscript(activePath)
    : false;

  const folder = await manuscriptFolder(work);
  const count = await countPlainText(folder);

  const items: Array<
    vscode.QuickPickItem & { choice?: "folder" | "one" }
  > = [];

  if (count > 0) {
    items.push({
      label: "$(files) この作品の本文をまとめて .md にする",
      description: `${count}件`,
      detail: `${folder} の中の .txt が対象です`,
      choice: "folder",
    });
  }
  if (activeIsText && activePath) {
    items.push({
      label: "$(file) いま開いているファイルだけ .md にする",
      description: path.basename(activePath),
      detail: activePath,
      choice: "one",
    });
  }

  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      "変換できる .txt が見つかりませんでした。本文がすでに .md か、本文フォルダーが空です。"
    );
    return false;
  }

  const picked = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { choice?: "folder" | "one" }
  >([...items, cancelItem()], {
    title: "本文を .md にする",
    placeHolder: "中身は変えず、名前だけを .md に変えます",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !picked.choice) return false;

  if (picked.choice === "one" && activePath) {
    return Boolean(await convertOne(activePath));
  }

  // **まとめて変えるときは、件数を見せてから確認する。**
  // 名前が変わるとGitからは「消して作った」に見えるので、
  // 何件動くのかを知らせてから実行する
  const answer = await vscode.window.showWarningMessage(
    `${count}件の .txt を .md にしますか？`,
    {
      modal: true,
      detail: [
        "中身は1文字も変えません。文字コードも改行もそのままです。",
        "戻したくなったら、名前を .txt に戻すだけで元どおりです。",
        "",
        "同じ名前の .md がすでにあるものは、上書きせずに飛ばします。",
      ].join("\n"),
    },
    "変換する"
  );
  if (answer !== "変換する") return false;

  // フォルダーの中の1件を起点にすれば、そのフォルダーがまるごと対象になる
  const names = await vscode.workspace.fs.readDirectory(path.toUri(folder));
  const first = names.find(
    ([name, kind]) =>
      kind === vscode.FileType.File && isPlainTextManuscript(name)
  );
  if (!first) return false;
  return Boolean(await convertFolder(path.join(folder, first[0])));
}

/**
 * 本文の置き場。
 *
 * **本文フォルダーが無ければ、作品フォルダーの直下を見る**
 * （`scanner.ts` と同じ扱い。話数ファイルを直に置く作者がいる）。
 */
async function manuscriptFolder(work: WorkEntry): Promise<string> {
  let config;
  try {
    config = await readWorkConfig(work);
  } catch {
    config = undefined;
  }
  const paths = workPaths(work, config);
  return (await pathExists(paths.manuscript)) ? paths.manuscript : paths.root;
}

async function countPlainText(folder: string): Promise<number> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(
      path.toUri(folder)
    );
    return entries.filter(
      ([name, kind]) =>
        kind === vscode.FileType.File && isPlainTextManuscript(name)
    ).length;
  } catch {
    return 0;
  }
}
