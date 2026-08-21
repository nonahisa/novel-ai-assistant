import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { isGitAvailable } from "../core/git";
import { cloneRepository, cloneWithGh, folderNameFromUrl } from "../core/gitClone";
import { ghAvailable, validateRepositoryUrl } from "../core/gitSetup";
import { pathExists } from "../core/fileSystem";
import { logFailure } from "../core/logger";
import type { WorkRegistry } from "../core/workRegistry";
import { withProgress } from "../views/progress";
import { askText } from "../views/dialogs";
import { tryRegisterAsCollection } from "./addCollection";

/**
 * GitHubにある作品を取り寄せて登録する（設計書5.5.11）。
 *
 * 別のPCで書いている作品を、新しい環境で開くための入口。
 * **既にあるフォルダーへは絶対に取り寄せない。** 同名のフォルダーがあれば
 * 中止する。上書きすると、その環境で書いた原稿が消える。
 */
export async function addWorkFromGithub(
  registry: WorkRegistry
): Promise<WorkEntry[]> {
  if (!(await isGitAvailable())) {
    const action = await vscode.window.showInformationMessage(
      "Gitが見つかりませんでした。GitHubから取り寄せるにはGitが必要です。",
      "導入方法を見る",
      "閉じる"
    );
    if (action === "導入方法を見る") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://git-scm.com/downloads")
      );
    }
    return [];
  }

  const url = await askText({
    title: "GitHubから作品を取り寄せる",
    prompt: "リポジトリのURLを貼り付けてください",
    placeHolder: "https://github.com/ユーザー名/リポジトリ名.git",
    ignoreFocusOut: true,
    validateInput: (value) => validateRepositoryUrl(value) ?? null,
  });
  if (!url) return [];

  const parent = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "ここに取り寄せる",
    title: "作品フォルダを置く場所を選択",
  });
  if (!parent || parent.length === 0) return [];

  const suggested = folderNameFromUrl(url);
  const folderName = await askText({
    title: "フォルダー名",
    prompt: "作品フォルダーの名前（あとから作品名は変えられます）",
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "フォルダー名を入力してください";
      if (/[/\\:*?"<>|]/.test(trimmed)) {
        return "フォルダー名に使えない文字が含まれています";
      }
      return null;
    },
  });
  if (!folderName) return [];

  const destination = path.join(parent[0].fsPath, folderName.trim());
  if (await pathExists(destination)) {
    vscode.window.showErrorMessage(
      `「${destination}」はすでに存在します。` +
        "中身を失わないため、取り寄せを中止しました。別の名前を指定してください。"
    );
    return [];
  }

  let result = await withProgress("GitHubから取り寄せています…", () =>
    cloneRepository(url.trim(), destination)
  );

  // 非公開のリポジトリは、認証を聞かれた時点で失敗する。
  // ghが使えるならそちらへ回すと、認証を持っているので通る
  if (!result.ok && result.needsAuth && (await ghAvailable())) {
    const retry = await vscode.window.showWarningMessage(
      "認証が必要なリポジトリのようです。GitHub CLI（gh）で取り寄せますか？",
      "ghで取り寄せる",
      "中止"
    );
    if (retry === "ghで取り寄せる") {
      result = await withProgress("GitHub CLIで取り寄せています…", () =>
        cloneWithGh(url.trim(), destination)
      );
    }
  }

  if (!result.ok) {
    logFailure("GitHubからの取り寄せ", {
      URL: url.trim(),
      詳細: result.detail ?? "",
    });
    const action = await vscode.window.showErrorMessage(
      result.needsAuth
        ? "取り寄せられませんでした。非公開のリポジトリなら、GitHub CLI（gh）を入れて " +
            "`gh auth login` を済ませてからもう一度お試しください。"
        : `取り寄せられませんでした: ${result.detail ?? "理由は不明です"}`,
      "ログを表示",
      "閉じる"
    );
    if (action === "ログを表示") {
      await vscode.commands.executeCommand("novelai.showLog");
    }
    return [];
  }

  // **取り寄せたものが作品集かもしれない。** 中に作品フォルダーが並んでいたら、
  // まとめて登録する（設計書5.7）。作者は1リポジトリに複数作品を置いており、
  // 以前はリポジトリ全体が1作品として登録されていた
  const collection = await tryRegisterAsCollection(registry, destination);
  if (collection.handled) return collection.added;

  const title = await askText({
    title: "作品名",
    prompt: "一覧に表示する作品名",
    value: folderName.trim(),
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "作品名を入力してください" : null,
  });
  // 名前を決めずに閉じても、取り寄せは終わっている。フォルダー名で登録する
  const entry = await registry.addExisting(
    destination,
    (title ?? folderName).trim()
  );
  if (!entry) return [];

  vscode.window.showInformationMessage(
    `「${entry.title}」を取り寄せて登録しました。`
  );
  return [entry];
}
