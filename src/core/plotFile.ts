import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import { PLOT_FILE, readWorkConfig, workPaths } from "./workRegistry";
import { atomicWriteFile, createManagedRecoveryPath } from "./atomicWrite";
import { updatePlotMarkdown, type PlotSections } from "./plotDoc";

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
      vscode.Uri.file(await plotPath(work))
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
  const target = await plotPath(work);
  const body = updatePlotMarkdown(await readPlotText(work), updates, {
    workTitle: work.title,
  });
  await writePlotText(target, body);
}

export async function writePlotText(
  target: string,
  body: string
): Promise<void> {
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.file(path.dirname(target))
  );

  if (await exists(target)) {
    const recoveryPath = await createManagedRecoveryPath(target);
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
    await atomicWriteFile(recoveryPath, bytes, { mode: "create" });
    await vscode.workspace.fs.delete(vscode.Uri.file(target), {
      useTrash: false,
    });
  }

  await atomicWriteFile(target, new TextEncoder().encode(body), {
    mode: "create",
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}
