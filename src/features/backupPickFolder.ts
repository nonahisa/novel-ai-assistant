// ログの書き先：作品が定まらない——バックアップを選ぶのは、取り込む作品が
// 決まる前（新しい作品を作る前・相談パネルで照合する前）だから
import * as vscode from "vscode";
import * as path from "../core/paths";
import { pathExists } from "../core/fileSystem";
import { logStep } from "../core/logger";

/**
 * バックアップを選ぶ画面を、前に選んだフォルダーから開く（2026-09-23）。
 *
 * ## なぜ要るか
 *
 * 作者は、なろうのバックアップを展開した `.txt` を何作ぶんも、作品ごとの
 * フォルダーへ並べて持っている。1作ずつ渡していくと、**毎回同じ作品
 * フォルダーから開き直して**、目当てのところまで辿り直すことになる
 * （ノートPCの実機、2026-09-23）。
 *
 * `defaultUri` を渡さないと、どこで開くかは VS Code 任せになる。
 * そこで**前回選んだファイルのフォルダー**を覚えておき、次に開くときの
 * `defaultUri` にする。
 *
 * ## 入口は2つ、覚える場所は1つ
 *
 * メニューの「バックアップから取り込む」（`importWorkFromZip.ts`）と、
 * 相談パネルの［バックアップを渡す］（`workChatPanel.ts`）は、どちらも
 * 同じバックアップを選ぶ画面である。片方で選んだ場所をもう片方でも使う。
 *
 * ## 覚える先
 *
 * `globalState`（作品ごとではなく、この拡張機能に1つ）。バックアップは
 * 作品フォルダーの外に置かれていることが多く、作品に紐づけても意味がない。
 * 起動のときに `initBackupPickFolder` で渡す。**渡されていなければ何も
 * 覚えず、これまでどおり VS Code 任せ**で開く（試験など）。
 *
 * ## ブラウザ版
 *
 * 場所は `paths.fromUri` の文字列で持ち、開くときは `paths.toUri` で戻す
 * （`vscode.Uri.file()` を直に使うと、`vscode-vfs:` の場所が壊れる）。
 * 覚えたフォルダーが今は無い（消した・別の機械の場所）ときは、既定を
 * 出さない——無い場所を指して開けないより、VS Code 任せのほうがよい。
 */

/** 覚えておく鍵。値は最後に選んだファイルのフォルダー（`fromUri` の形） */
export const BACKUP_PICK_FOLDER_KEY = "novelai.lastBackupPickFolder";

let memory: vscode.Memento | undefined;

/** 起動のときに1度だけ呼ぶ（`extension.ts`） */
export function initBackupPickFolder(state: vscode.Memento): void {
  memory = state;
}

/**
 * バックアップを1つ選ばせる。選ばれたら、そのフォルダーを覚える。
 *
 * `options.defaultUri` を渡したときはそちらを優先する（覚えた場所で
 * 上書きしない）。
 */
export async function showBackupOpenDialog(
  options: vscode.OpenDialogOptions
): Promise<vscode.Uri | undefined> {
  const defaultUri = options.defaultUri ?? (await rememberedFolderUri());
  const picked = await vscode.window.showOpenDialog({
    ...options,
    ...(defaultUri ? { defaultUri } : {}),
  });
  const uri = picked?.[0];
  if (uri) await rememberFolderOf(uri);
  return uri;
}

async function rememberedFolderUri(): Promise<vscode.Uri | undefined> {
  const folder = memory?.get<string>(BACKUP_PICK_FOLDER_KEY);
  if (typeof folder !== "string" || folder.trim() === "") return undefined;
  try {
    return (await pathExists(folder)) ? path.toUri(folder) : undefined;
  } catch (error) {
    // 調べられない（権限など）ときも、無いときと同じく VS Code 任せにする。
    // 選ぶ画面が出ないよりはよいので、止めずに記録だけ残す
    logStep(
      `バックアップを選ぶ画面：前に選んだ場所を確かめられませんでした（${
        error instanceof Error ? error.message : String(error)
      }）`
    );
    return undefined;
  }
}

async function rememberFolderOf(uri: vscode.Uri): Promise<void> {
  if (!memory) return;
  try {
    await memory.update(
      BACKUP_PICK_FOLDER_KEY,
      path.dirname(path.fromUri(uri))
    );
  } catch (error) {
    // 覚えられなくても、選んだファイルはそのまま使える。止めない
    logStep(
      `バックアップを選ぶ画面：選んだ場所を覚えられませんでした（${
        error instanceof Error ? error.message : String(error)
      }）`
    );
  }
}
