import * as vscode from "vscode";
import * as path from "./paths";
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
  subtitle: string,
  /**
   * 名前の前後で呼ぶ手当て。開いている原稿エディターの見た目を新しい名前へ
   * 持って行く・古い面を閉じる、は画面側（features）の仕事で、core からは
   * 呼べない（依存の向き）ので、呼ぶ側から差し込む。
   */
  hooks?: {
    beforeRename?: (from: string, to: string) => void;
    afterRename?: (from: string) => void;
  }
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

  // 見た目の持ち越しは、画面がまだ元の名前で開いているうちに取る
  hooks?.beforeRename?.(file.filePath, target);
  await vscode.workspace.fs.rename(
    path.toUri(file.filePath),
    path.toUri(target),
    // 上書きを許すと、同名の別の話が消える
    { overwrite: false }
  );
  // 改名が通ってから閉じる（失敗したときに面だけが消えないように）
  hooks?.afterRename?.(file.filePath);
  return target;
}

/** 付けようとしているファイル名を、作者に見せるために作る */
export function renamedFileName(file: EpisodeFile, subtitle: string): string {
  const base = path.basename(file.fileName, file.ext);
  return `${base}_${sanitizeFileName(subtitle).trim()}${file.ext}`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(filePath));
    return true;
  } catch {
    return false;
  }
}
