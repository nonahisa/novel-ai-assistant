import * as vscode from "vscode";
import * as path from "path";
import type { EpisodeFile } from "../models/types";
import { sanitizeFileName } from "./episodeParser";

/**
 * サブタイトルを付けてファイル名を変える。`007.txt` → `007_湖畔の誓い.txt`
 *
 * **作者の原稿ファイルそのものを触る操作**なので、次を守る。
 *
 * - 話数の部分は元のファイル名をそのまま使う。`007` を `7` に詰めない
 *   （ゼロ埋めの桁数は作者の並べ方であり、勝手に変えると並び順が崩れる）
 * - 既にあるファイル名にはしない。上書きすれば別の話が消える
 * - 中身には一切触らない。名前だけを変える
 */
export async function renameEpisodeFile(
  file: EpisodeFile,
  subtitle: string
): Promise<string> {
  const cleaned = sanitizeFileName(subtitle).trim();
  if (!cleaned) {
    throw new Error("サブタイトルが空になりました。");
  }

  const base = path.basename(file.fileName, file.ext);
  const target = path.join(
    path.dirname(file.filePath),
    `${base}_${cleaned}${file.ext}`
  );

  if (target === file.filePath) {
    throw new Error("すでに同じ名前です。");
  }
  if (await exists(target)) {
    throw new Error(`${path.basename(target)} が既にあります。`);
  }

  await vscode.workspace.fs.rename(
    vscode.Uri.file(file.filePath),
    vscode.Uri.file(target),
    // 上書きを許すと、同名の別の話が消える
    { overwrite: false }
  );
  return target;
}

/** 付けようとしているファイル名を、作者に見せるために作る */
export function renamedFileName(file: EpisodeFile, subtitle: string): string {
  const base = path.basename(file.fileName, file.ext);
  return `${base}_${sanitizeFileName(subtitle).trim()}${file.ext}`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}
