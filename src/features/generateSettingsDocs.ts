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
  createWorldStore,
} from "../core/abilityStore";
import {
  buildAbilityMarkdown,
  buildCharacterMarkdown,
  buildLocationMarkdown,
  buildOrganizationMarkdown,
  buildWorldMarkdown,
} from "../core/settingsMarkdown";
import { CustomFieldStore } from "../core/customFieldStore";
import { SynopsisStore } from "../core/synopsisStore";
import { emptySynopsisSet } from "../models/synopsis";
import { refreshSynopsisDoc } from "./generateBlurb";
import { buildSchemaFiles, SCHEMA_DIR } from "../core/settingsSchema";
import { logFailure } from "../core/logger";

/**
 * 設定資料のMarkdownを生成する。
 *
 * 生成のたびに全体を書き直すため、作者が直接手を入れる文書ではない。
 * 資料に載せたい補足は各JSONの exportNote / authorNotes に書く。
 * その旨をファイル冒頭にも書いて、手編集が失われる事故を防ぐ。
 */

/** 生成物である印。既にあるファイルを上書きしてよいかの判断に使う */
export const GENERATED_MARKER =
  "このファイルは「設定資料集を出力」で自動生成されます。";

const GENERATED_NOTICE =
  `<!-- ${GENERATED_MARKER}\n` +
  "     直接編集しても次回の生成で失われます。\n" +
  "     補足を残したい場合は各JSONの exportNote / authorNotes に書いてください。 -->\n";

/**
 * 資料の種別。
 *
 * 種別ごとに書き出せるようにしてあるのは、**JSONを1種類だけ直したときに、
 * その一覧だけを作り直したい**ことがあるため。全部を書き直しても結果は
 * 同じだが、何が更新されたのかが分からなくなる。
 */
export type SettingsDocKind =
  | "characters"
  | "abilities"
  | "organizations"
  | "locations"
  | "world"
  | "synopses";

interface GeneratedDoc {
  kind: SettingsDocKind;
  fileName: string;
  label: string;
  content: string;
  /** 該当が無い種別は書き出さない */
  hasContent: boolean;
}

/**
 * 既にあるファイルを上書きしてよいか。
 *
 * **設計書は `world.md` を「AI自動生成＋作者の加筆」としていた。**
 * その案で書き始めた作者のファイルが残っている可能性があるため、
 * 生成物の印が無いファイルは作者が書いたものとみなして触らない。
 * 上書きしてから謝っても、文章は戻らない。
 */
export function isGeneratedDoc(existing: string): boolean {
  return existing.includes(GENERATED_MARKER);
}

/** 既存ファイルが作者の手書きなら true（＝書き込んではいけない） */
async function isAuthorWritten(target: string): Promise<boolean> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
    return !isGeneratedDoc(new TextDecoder().decode(bytes));
  } catch (error) {
    // 読めない理由が「まだ無い」なら書いてよい。
    // 権限などの他の失敗は、書き込み側で改めて失敗させる
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    ) {
      return false;
    }
    return false;
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return true;
  } catch {
    return false;
  }
}

export interface GenerateSettingsDocsOptions {
  /**
   * 成功時の通知を出さない。
   * 抽出の直後に続けて呼ぶときに使う。
   * 抽出結果の要約をすでに出しているので、通知が二重になるのを避ける。
   * 失敗は静かにできないため、silent でもそのまま知らせる。
   */
  silent?: boolean;
  /**
   * 書き出す種別。指定しなければ全部。
   *
   * **AI向けの定義（`_schema/`）は種別を絞っても毎回書き直す。**
   * 定義は資料そのものではなく、他のツールが設定JSONを読むための約束なので、
   * 一部だけ古い状態を残すと食い違いの原因になる。
   */
  kinds?: readonly SettingsDocKind[];
}

export async function generateSettingsDocs(
  work: WorkEntry,
  options: GenerateSettingsDocsOptions = {}
): Promise<void> {
  const characterStore = new CharacterStore(work);
  const abilityStore = createAbilityStore(work);
  const locationStore = createLocationStore(work);
  const organizationStore = createOrganizationStore(work);
  const worldStore = createWorldStore(work);

  const loadedCharacters = await characterStore.loadAll();
  const loadedAbilities = await abilityStore.loadAll();
  const loadedLocations = await locationStore.loadAll();
  const loadedOrganizations = await organizationStore.loadAll();
  const loadedWorld = await worldStore.loadAll();
  const abilitySystem = await new AbilitySystemStore(work).load();

  // 壊れたJSONがあるまま資料を作ると、欠けた資料が正しく見えてしまう
  const errors = [
    ...loadedCharacters.errors,
    ...loadedAbilities.errors,
    ...loadedLocations.errors,
    ...loadedOrganizations.errors,
    ...loadedWorld.errors,
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

  // あらすじが読めなくても他の資料は作る。壊れたJSONで全部を止めない
  let synopses = emptySynopsisSet();
  try {
    synopses = await new SynopsisStore(work).load();
  } catch {
    // 生成できないのはあらすじの節だけ。理由は生成時に既に知らせている
  }
  const markdownOptions = { workTitle: work.title, customFields };
  const abilityTerm = abilitySystem.abilityTerm || "能力";

  const allDocs: GeneratedDoc[] = [
    {
      kind: "characters",
      fileName: "characters.md",
      label: "登場人物",
      content: buildCharacterMarkdown(
        loadedCharacters.characters,
        markdownOptions
      ),
      hasContent: loadedCharacters.characters.length > 0,
    },
    {
      kind: "abilities",
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
      kind: "organizations",
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
      kind: "locations",
      fileName: "locations.md",
      label: "場所",
      content: buildLocationMarkdown(loadedLocations.records, markdownOptions),
      hasContent: loadedLocations.records.length > 0,
    },
    {
      kind: "world",
      fileName: "world.md",
      label: "世界観",
      content: buildWorldMarkdown(loadedWorld.records, markdownOptions),
      hasContent: loadedWorld.records.length > 0,
    },
  ];

  // 種別を絞られていれば、その種別だけを書き出す
  const docs = options.kinds
    ? allDocs.filter((doc) => options.kinds!.includes(doc.kind))
    : allDocs;

  const config = await readWorkConfig(work);
  const settingsDir = workPaths(work, config).settings;
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(settingsDir));

  // 他のツール・AIが設定資料を読み書きするための定義を置く。
  // 資料を作るたびに書き直すので、字数上限などを変えても古びない
  await writeSchemaFiles(settingsDir, work.title);

  const written: string[] = [];
  /**
   * 各話あらすじは `synopsis.md`（作品紹介文と同じ文書）へ載せる。
   *
   * **この文書だけは、下の書き出しループに任せられない。** ループは
   * 「全体を生成物として書き直す」前提で、作者が書いたと見えるファイルは
   * 触らない。ところがこの文書には作者の紹介文が含まれるので、その判定に
   * かかると永久に更新されなくなる。紹介文を残して あらすじ の部分だけを
   * 差し替える専用の書き手（`refreshSynopsisDoc`）へ回す。
   */
  const wantsSynopses = !options.kinds || options.kinds.includes("synopses");
  if (wantsSynopses && synopses.episodes.length > 0) {
    try {
      await refreshSynopsisDoc(work, work.title);
      written.push("各話あらすじ");
    } catch (error) {
      await vscode.window.showErrorMessage(
        "各話あらすじを保存できませんでした。" +
          (error instanceof Error ? error.message : String(error))
      );
      return;
    }

    // 統合前に作られた synopses.md が残っていると、古い内容を最新だと
    // 思って読んでしまう。消すのは作者の判断なので、知らせるだけにする
    const retired = path.join(settingsDir, "synopses.md");
    if (!options.silent && (await fileExists(retired))) {
      void vscode.window.showInformationMessage(
        "各話あらすじは 設定/synopsis.md へまとめました。" +
          "古い 設定/synopses.md はもう更新されません。不要なら削除してください。"
      );
    }
  }

  const writtenFiles: string[] = [];
  const skipped: string[] = [];
  /** 作者が書いたと判断して触らなかったファイル */
  const protectedFiles: string[] = [];

  for (const doc of docs) {
    if (!doc.hasContent) {
      skipped.push(doc.label);
      continue;
    }
    const target = path.join(settingsDir, doc.fileName);
    if (await isAuthorWritten(target)) {
      protectedFiles.push(doc.fileName);
      continue;
    }
    try {
      await atomicWriteFile(
        target,
        new TextEncoder().encode(GENERATED_NOTICE + "\n" + doc.content)
      );
      written.push(doc.label);
      writtenFiles.push(doc.fileName);
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

  // 作者のファイルを避けたことは、黙っていると「生成されない」不具合に見える。
  // 抽出直後（silent）でも必ず伝える
  if (protectedFiles.length > 0) {
    void vscode.window.showWarningMessage(
      `${protectedFiles.join("・")} は作者が書いたファイルのようなので、` +
        "上書きせずそのままにしました。生成し直す場合は、内容を移してから削除してください。"
    );
  }

  if (written.length === 0) {
    if (options.silent) return;
    if (protectedFiles.length > 0) return;
    // 種別を絞って呼ばれたときに「資料が無い」とだけ言うと、
    // 何の資料が無いのか分からない
    const target = options.kinds
      ? `${docs.map((doc) => doc.label).join("・")}の設定`
      : "資料にできる設定";
    vscode.window.showInformationMessage(
      `${target}がまだありません。先に「まとめて生成」で抽出してください。`
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
    // 書いたファイルを開く。避けたファイルを開くと、
    // 生成できたのか分からないまま古い内容を見せることになる
    const first = { fileName: writtenFiles[0] };
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
