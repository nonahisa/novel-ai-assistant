import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { atomicWriteFile } from "../core/atomicWrite";
import {
  DICTIONARY_FORMATS,
  buildDictionary,
  encodeDictionary,
  formatDictionary,
  type ImeDialect,
} from "../core/imeDictionary";

/**
 * 抽出済みの設定からIMEのユーザー辞書を書き出す。
 *
 * 作品固有の固有名詞は変換で出てこないため、毎回打ち直すことになる。
 * 形式はIMEによって違うので、実行のたびに作者が選ぶ。
 * 設定に固定しないのは、複数のIMEを併用することがあるため。
 */
export async function exportImeDictionary(work: WorkEntry): Promise<void> {
  const loadedCharacters = await new CharacterStore(work).loadAll();
  const loadedAbilities = await createAbilityStore(work).loadAll();
  const loadedLocations = await createLocationStore(work).loadAll();
  const loadedOrganizations = await createOrganizationStore(work).loadAll();
  const loadedWorld = await createWorldStore(work).loadAll();

  const errors = [
    ...loadedCharacters.errors,
    ...loadedAbilities.errors,
    ...loadedLocations.errors,
    ...loadedOrganizations.errors,
    ...loadedWorld.errors,
  ];
  if (errors.length > 0) {
    // 読めない設定があるまま書き出すと、欠けた辞書が正しく見えてしまう
    await vscode.window.showErrorMessage(
      "読み込めない設定ファイルがあるため、辞書を書き出しませんでした。" +
        `（${errors.map((error) => error.file).join("、")}）`
    );
    return;
  }

  const built = buildDictionary({
    characters: loadedCharacters.characters,
    abilities: loadedAbilities.records,
    locations: loadedLocations.records,
    organizations: loadedOrganizations.records,
    worldItems: loadedWorld.records,
  });

  if (built.entries.length === 0) {
    vscode.window.showInformationMessage(
      "辞書にできる語がありません。先に「設定資料を抽出」を実行してください。"
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    Object.values(DICTIONARY_FORMATS).map((format) => ({
      label: format.label,
      description: format.fileName,
      detail: format.howTo,
      picked: true,
      dialect: format.dialect,
    })),
    {
      title: `${built.entries.length} 語を書き出します。形式を選んでください`,
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked || picked.length === 0) return;

  const config = await readWorkConfig(work);
  const settingsDir = workPaths(work, config).settings;
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(settingsDir));

  const written: string[] = [];
  for (const entry of picked) {
    const format = DICTIONARY_FORMATS[entry.dialect as ImeDialect];
    const body = formatDictionary(built.entries, format.dialect, work.title);
    const target = path.join(settingsDir, format.fileName);
    try {
      await atomicWriteFile(target, encodeDictionary(body, format.encoding));
      written.push(format.fileName);
    } catch (error) {
      await vscode.window.showErrorMessage(
        `${format.label}用の辞書を保存できませんでした。` +
          (error instanceof Error ? error.message : String(error))
      );
      return;
    }
  }

  const missingNote =
    built.missingReading.length > 0
      ? `\n読みが未入力のため除いた語が ${built.missingReading.length} 件あります` +
        `（${built.missingReading.slice(0, 5).join("、")}${
          built.missingReading.length > 5 ? " ほか" : ""
        }）。設定資料パネルの「読み」に入力すると次回から含まれます。`
      : "";

  const action = await vscode.window.showInformationMessage(
    `${built.entries.length} 語の辞書を書き出しました（${written.join("、")}）。` +
      `${missingNote}\n取り込み手順は各IMEの辞書ツールから行ってください。`,
    "フォルダーを開く",
    "取り込み手順を見る"
  );

  if (action === "フォルダーを開く") {
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(path.join(settingsDir, written[0]))
    );
  } else if (action === "取り込み手順を見る") {
    const document = await vscode.workspace.openTextDocument({
      content: buildHowToDocument(picked.map((entry) => entry.dialect as ImeDialect)),
      language: "markdown",
    });
    await vscode.window.showTextDocument(document);
  }
}

function buildHowToDocument(dialects: ImeDialect[]): string {
  const lines = ["# IME辞書の取り込み手順", ""];
  for (const dialect of dialects) {
    const format = DICTIONARY_FORMATS[dialect];
    lines.push(`## ${format.label}`, "");
    lines.push(`ファイル: \`設定/${format.fileName}\``, "");
    lines.push(format.howTo, "");
    lines.push(
      `文字コードは ${
        format.encoding === "utf16le" ? "UTF-16 LE（BOM付き）" : "UTF-8"
      } で書き出しています。`,
      ""
    );
  }
  lines.push(
    "## うまく取り込めない場合",
    "",
    "文字コードが合っていない可能性があります。取り込み時のエラー内容を控えて、",
    "拡張機能の開発側へ伝えてください。形式を調整します。",
    ""
  );
  return lines.join("\n");
}
