import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { renamePlotHeading } from "../core/plotDoc";
import { plotPath } from "../core/plotFile";
import {
  readTextFile,
  writeTextFilePreservingFormat,
  type WriteTextFileResult,
} from "../core/textFile";
import {
  readWorkConfig,
  writeWorkConfig,
  type WorkRegistry,
} from "../core/workRegistry";
import { askText } from "../views/dialogs";
import { notifyDone } from "../views/notify";

/**
 * 作品名を変える（設計書6.1.1。作者の依頼、2026-09-10）。
 *
 * 題は3か所にある。
 *
 * 1. 登録（`globalState` の `WorkEntry.title`）——一覧・ステータスバー・
 *    作品を選ぶ画面に出るのはこれ
 * 2. 作品の設定ファイル（`.aiwriter/config.json` の `workTitle`）——
 *    別のPCで登録し直したときに、この題が引き継がれる
 * 3. プロット（`設定/plot.md`）の先頭の `# 〈題〉`——**作者の文書**
 *
 * **フォルダー名は変えない。** 置き場所が変わると、GitHubの同期先・
 * 登録・書庫の並びがまとめて切れる。呼び名を変えたいだけの操作で
 * 作品が行方不明になるほうが、名前とフォルダーが食い違うより重い。
 */
export async function renameWork(
  registry: WorkRegistry,
  work: WorkEntry
): Promise<boolean> {
  const answer = await askText({
    title: "作品名を変更",
    prompt: "この作品の呼び名を変えます。フォルダー名は変わりません",
    value: work.title,
    validateInput: (value) =>
      value.trim().length === 0 ? "作品名を入れてください" : null,
  });
  // Esc（取りやめ）と、直さずに確定したときは何もしない
  if (answer === undefined) return false;

  const newTitle = answer.trim();
  const oldTitle = work.title;
  if (newTitle.length === 0 || newTitle === oldTitle) return false;

  // ① 登録。`onDidChange` が飛ぶので、一覧とステータスバーはここで追随する
  const renamed = await registry.rename(work.id, newTitle);
  if (!renamed) {
    void vscode.window.showWarningMessage(
      `「${oldTitle}」は登録されていません（別の画面で解除された可能性があります）。`
    );
    return false;
  }

  // **通らなかったところは、必ず言う。** 黙って一部だけ変えると、
  // どこが古い題のままなのかを作者が探すことになる
  const notes: string[] = [];
  notes.push(...(await updateConfigTitle(renamed, newTitle)));
  notes.push(...(await updatePlotTitle(renamed, oldTitle, newTitle)));

  const message = `作品名を「${oldTitle}」から「${newTitle}」に変えました。`;
  if (notes.length === 0) {
    // 件数も保存先も伴わない完了なので、ステータスバーで足りる（notify.ts）
    notifyDone(message);
  } else {
    // 断りが付くものは消えると困る。通知に出したうえでログにも残す
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）。向けないと
    // 出力チャンネル止まりで、VS Code を閉じると消える
    useLogFile(work.folderPath);
    logStep(`${message}${notes.join("")}`);
    void vscode.window.showInformationMessage(`${message}${notes.join("")}`);
  }
  return true;
}

/**
 * ② 作品の設定ファイルの `workTitle`。
 *
 * **無ければ作らない。** 設定ファイルを持たない作品（フォルダーを
 * そのまま登録しただけのもの）は、無いままで動く。ここで作ると、
 * 名前を変えただけなのに本文・設定の置き場が既定値で固定される。
 */
async function updateConfigTitle(
  work: WorkEntry,
  newTitle: string
): Promise<string[]> {
  try {
    const config = await readWorkConfig(work);
    if (!config) return [];
    await writeWorkConfig(work, { ...config, workTitle: newTitle });
    return [];
  } catch (error) {
    useLogFile(work.folderPath);
    logFailure("作品名の変更（作品の設定ファイル）", {
      作品: work.title,
      理由: describeError(error),
    });
    return [
      "作品の設定ファイル（.aiwriter/config.json）は書き換えられませんでした。",
    ];
  }
}

/**
 * ③ プロットの先頭の見出し。
 *
 * **元の題と同じときだけ変える。** 作者が書き換えた見出しを、
 * 登録名の変更のついでに上書きしない（`renamePlotHeading`）。
 */
async function updatePlotTitle(
  work: WorkEntry,
  oldTitle: string,
  newTitle: string
): Promise<string[]> {
  let target: string;
  try {
    target = await plotPath(work);
  } catch (error) {
    // 設定ファイルが読めないときはここも通らない。②で既に断っている
    useLogFile(work.folderPath);
    logFailure("作品名の変更（プロットの場所）", {
      作品: newTitle,
      理由: describeError(error),
    });
    return [];
  }

  // プロットを作っていない作品のほうが多い。無いことは断りにしない
  if (!(await exists(target))) return [];

  try {
    const content = await readTextFile(target);
    const { text, changed } = renamePlotHeading(content.text, oldTitle, newTitle);
    if (!changed) {
      return ["プロットの見出しは元の題と違ったので変えていません。"];
    }

    // 本文と同じ扱いで書き戻す（文字コード・改行を保ち、読み込み後に
    // 外から変えられていたら書かない。CLAUDE.mdの「原稿を壊さない」）
    const result = await writeTextFilePreservingFormat(
      target,
      text,
      content,
      content.hash
    );
    if (result.ok) return [];
    return [
      `プロットの見出しは書き換えられませんでした（${describeWriteFailure(result)}）。`,
    ];
  } catch (error) {
    useLogFile(work.folderPath);
    logFailure("作品名の変更（プロットの見出し）", {
      作品: newTitle,
      理由: describeError(error),
    });
    return ["プロットの見出しは書き換えられませんでした。"];
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(filePath));
    return true;
  } catch {
    return false;
  }
}

function describeWriteFailure(result: WriteTextFileResult): string {
  if (result.ok) return "";
  switch (result.reason) {
    case "unsaved_changes":
      return "開いたまま直していない変更があります";
    case "conflict_markers":
      return "競合の印（<<<<<<<）が残っています";
    case "modified_externally":
      return "読み込んだあとに、他の場所から変更されました";
    default:
      return result.detail ?? "書き込めませんでした";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
