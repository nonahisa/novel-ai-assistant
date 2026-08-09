import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { atomicWriteFile, AtomicWriteFileError } from "../core/atomicWrite";
import { CharacterStore } from "../core/characterStore";
import {
  AbilitySystemStore,
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
} from "../core/abilityStore";
import {
  buildAbilityMarkdown,
  buildCharacterMarkdown,
  buildLocationMarkdown,
  buildOrganizationMarkdown,
} from "../core/settingsMarkdown";
import { CustomFieldStore } from "../core/customFieldStore";
import { buildSchemaFiles, SCHEMA_DIR } from "../core/settingsSchema";
import { logFailure } from "../core/logger";

/**
 * 設定資料のMarkdownを生成する。
 *
 * 生成のたびに全体を書き直すため、作者が直接手を入れる文書ではない。
 * 資料に載せたい補足は各JSONの exportNote / authorNotes に書く。
 * その旨をファイル冒頭にも書いて、手編集が失われる事故を防ぐ。
 */

const GENERATED_NOTICE =
  "<!-- このファイルは「設定資料集を出力」で自動生成されます。\n" +
  "     直接編集しても次回の生成で失われます。\n" +
  "     補足を残したい場合は各JSONの exportNote / authorNotes に書いてください。 -->\n";

interface GeneratedDoc {
  fileName: string;
  label: string;
  content: string;
  /** 該当が無い種別は書き出さない */
  hasContent: boolean;
}

export interface GenerateSettingsDocsOptions {
  /**
   * 成功時の通知を出さない。
   * 抽出の直後に続けて呼ぶときに使う。
   * 抽出結果の要約をすでに出しているので、通知が二重になるのを避ける。
   * 失敗は静かにできないため、silent でもそのまま知らせる。
   */
  silent?: boolean;
}

export async function generateSettingsDocs(
  work: WorkEntry,
  options: GenerateSettingsDocsOptions = {}
): Promise<void> {
  const characterStore = new CharacterStore(work);
  const abilityStore = createAbilityStore(work);
  const locationStore = createLocationStore(work);
  const organizationStore = createOrganizationStore(work);

  const loadedCharacters = await characterStore.loadAll();
  const loadedAbilities = await abilityStore.loadAll();
  const loadedLocations = await locationStore.loadAll();
  const loadedOrganizations = await organizationStore.loadAll();
  const abilitySystem = await new AbilitySystemStore(work).load();

  // 壊れたJSONがあるまま資料を作ると、欠けた資料が正しく見えてしまう
  const errors = [
    ...loadedCharacters.errors,
    ...loadedAbilities.errors,
    ...loadedLocations.errors,
    ...loadedOrganizations.errors,
  ];
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.file}: ${e.message}`).join("\n");
    const action = await vscode.window.showErrorMessage(
      "読み込めない設定ファイルがあるため、資料を生成しませんでした。" +
        "欠けたまま資料を作ると、不足に気づけないためです。",
      "詳細を表示",
      "閉じる"
    );
    if (action === "詳細を表示") {
      const doc = await vscode.workspace.openTextDocument({
        content: detail,
        language: "text",
      });
      await vscode.window.showTextDocument(doc);
    }
    return;
  }

  // 項目の定義が読めなくても資料は作る。追加項目の欄が出ないだけで、
  // 既定の項目まで書き出せなくなるほうが困る
  const customFields = await new CustomFieldStore(work).loadFields();
  const markdownOptions = { workTitle: work.title, customFields };
  const abilityTerm = abilitySystem.abilityTerm || "能力";

  const docs: GeneratedDoc[] = [
    {
      fileName: "characters.md",
      label: "登場人物",
      content: buildCharacterMarkdown(
        loadedCharacters.characters,
        markdownOptions
      ),
      hasContent: loadedCharacters.characters.length > 0,
    },
    {
      fileName: "abilities.md",
      label: abilityTerm,
      content: buildAbilityMarkdown(
        loadedAbilities.records,
        abilitySystem,
        markdownOptions
      ),
      // 能力体系の無い作品に空の一覧を作らない
      hasContent: loadedAbilities.records.length > 0,
    },
    {
      fileName: "organizations.md",
      label: "組織",
      content: buildOrganizationMarkdown(
        loadedOrganizations.records,
        loadedCharacters.characters,
        markdownOptions
      ),
      hasContent: loadedOrganizations.records.length > 0,
    },
    {
      fileName: "locations.md",
      label: "場所",
      content: buildLocationMarkdown(loadedLocations.records, markdownOptions),
      hasContent: loadedLocations.records.length > 0,
    },
  ];

  const config = await readWorkConfig(work);
  const settingsDir = workPaths(work, config).settings;
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(settingsDir));

  // 他のツール・AIが設定資料を読み書きするための定義を置く。
  // 資料を作るたびに書き直すので、字数上限などを変えても古びない
  await writeSchemaFiles(settingsDir, work.title);

  const written: string[] = [];
  const skipped: string[] = [];

  for (const doc of docs) {
    if (!doc.hasContent) {
      skipped.push(doc.label);
      continue;
    }
    const target = path.join(settingsDir, doc.fileName);
    try {
      await atomicWriteFile(
        target,
        new TextEncoder().encode(GENERATED_NOTICE + "\n" + doc.content)
      );
      written.push(doc.label);
    } catch (error) {
      const detail =
        error instanceof AtomicWriteFileError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      await vscode.window.showErrorMessage(
        `${doc.label}一覧を保存できませんでした。${detail}`
      );
      return;
    }
  }

  if (written.length === 0) {
    if (options.silent) return;
    vscode.window.showInformationMessage(
      "資料にできる設定がまだありません。先に「設定資料を抽出」を実行してください。"
    );
    return;
  }

  if (options.silent) return;

  const skippedNote =
    skipped.length > 0 ? `（${skipped.join("・")}は該当なし）` : "";
  const action = await vscode.window.showInformationMessage(
    `${written.join("・")}の一覧を生成しました。${skippedNote}`,
    "開く"
  );
  if (action === "開く") {
    const first = docs.find((doc) => doc.hasContent)!;
    // 資料は読むためのものなので、記法のままではなくプレビューで開く
    await vscode.commands.executeCommand(
      "markdown.showPreview",
      vscode.Uri.file(path.join(settingsDir, first.fileName))
    );
  }
}

/**
 * 他のツール・AIへ渡す定義を書き出す。
 *
 * 生成物なので上書きしてよい。作者が手を入れる文書ではない
 * （README にもそう書いてある）。
 *
 * **書けなくても資料の生成は止めない。** 定義が無いのは不便だが、
 * 資料そのものが作れないほうが困る。
 */
async function writeSchemaFiles(
  settingsDir: string,
  workTitle: string
): Promise<void> {
  const directory = path.join(settingsDir, SCHEMA_DIR);
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
    for (const file of buildSchemaFiles(workTitle)) {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(directory, file.fileName)),
        new TextEncoder().encode(file.content)
      );
    }
  } catch (error) {
    logFailure("AI向けの定義の書き出し", {
      作品: workTitle,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }
}
