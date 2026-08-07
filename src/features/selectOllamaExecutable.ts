import * as vscode from "vscode";
import * as path from "node:path";
import {
  checkSelectedExecutable,
  executableCandidates,
  openDialogFilters,
  resolveExecutable,
} from "../ai/ollamaLauncher";

const SETTING_KEY = "ollama.executablePath";

/**
 * Ollamaの実行ファイルを選択ダイアログで指定する。
 *
 * 設定画面のテキスト欄はパスを手入力するしかないため、
 * ファイルを選ぶだけで済むようにこのコマンドを用意している。
 */
export async function selectOllamaExecutable(): Promise<void> {
  const config = vscode.workspace.getConfiguration("novelai");
  const current = config.get<string>(SETTING_KEY, "").trim();

  // 既に指定があればそこを、無ければ自動検出できた場所を初期表示にする
  const detected = current || (await resolveExecutable());
  const defaultUri = await defaultDialogUri(detected);

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "この実行ファイルを使う",
    title: "Ollamaの実行ファイルを選択",
    filters: openDialogFilters(),
    defaultUri,
  });
  if (!picked || picked.length === 0) return;

  const filePath = picked[0].fsPath;
  const check = await checkSelectedExecutable(filePath);

  if (check.verdict === "missing") {
    await vscode.window.showErrorMessage(
      "選択したファイルを読み取れませんでした。別のファイルを選んでください。"
    );
    return;
  }

  if (check.verdict === "suspicious") {
    // 名前が違うだけで拒否はしない。ラッパー経由の運用もありうるため
    const answer = await vscode.window.showWarningMessage(
      `${check.reason}このまま設定しますか？\n${filePath}`,
      "このまま設定",
      "選び直す",
      "中止"
    );
    if (answer === "選び直す") {
      await selectOllamaExecutable();
      return;
    }
    if (answer !== "このまま設定") return;
  }

  await config.update(
    SETTING_KEY,
    filePath,
    vscode.ConfigurationTarget.Global
  );
  vscode.window.showInformationMessage(
    `Ollamaの実行ファイルを設定しました。\n${filePath}`
  );
}

/** 自動検出できていればその場所を、無ければ既定のインストール先を開く */
async function defaultDialogUri(
  detected: string | undefined
): Promise<vscode.Uri | undefined> {
  if (detected && path.isAbsolute(detected)) {
    return vscode.Uri.file(path.dirname(detected));
  }
  // PATH解決に任せていた場合は場所が分からないので、既定の候補から探す
  const absolute = executableCandidates().find((c) => path.isAbsolute(c));
  return absolute ? vscode.Uri.file(path.dirname(absolute)) : undefined;
}
