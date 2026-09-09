import * as vscode from "vscode";
import * as path from "../core/paths";
import { atomicWriteFile } from "../core/atomicWrite";
import {
  AbilitySystemStore,
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { BookStore } from "../core/bookStore";
import { CharacterStore } from "../core/characterStore";
import { CustomFieldStore } from "../core/customFieldStore";
import {
  AUDIENCE_PROFILES,
  EXPORT_AUDIENCES,
  buildExportMarkdown,
  type ExportAudience,
  type SettingsExportData,
} from "../core/settingsExportProfiles";
import {
  TIMESTAMPED_NAME_TRIES,
  timestampedFileNameCandidates,
} from "../core/timestampedFileName";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import type { WorkEntry } from "../models/types";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 提供先を選んで設定資料を書き出す（設計書6.75）。
 *
 * **AIは呼ばない。** 抽出済みのJSONから、提供先の型に合った項目だけを
 * 選んで1つのMarkdownにまとめる。何を出すかの判断は
 * `core/settingsExportProfiles.ts` の表だけが持つ（ここは訊いて書くだけ）。
 */

/** 書き出すファイル名の、拡張子を除いた部分 */
export function exportFileBaseName(
  audience: ExportAudience,
  chapter: number | null
): string {
  const scope = chapter === null ? "全話" : `第${chapter}話まで`;
  return `設定資料（${AUDIENCE_PROFILES[audience].fileLabel}・${scope}）`;
}

/**
 * 試す順に名前を並べる。
 *
 * **いちばん先に試すのは、時刻の付かない名前。** 何度も書き出すものでは
 * ないので、ふだんは読みやすい名前で置きたい。ぶつかったときの避け方
 * （分 → 秒 → 連番）は `timestampedFileName.ts` が持っている規則に従う
 * ——**既存ファイルは上書きできない**（`atomicWrite.ts`）ので、
 * 逃げ道が要る。
 */
export function exportFileNameCandidates(
  audience: ExportAudience,
  chapter: number | null,
  at: Date,
  tries: number = TIMESTAMPED_NAME_TRIES
): string[] {
  const base = exportFileBaseName(audience, chapter);
  return [
    `${base}.md`,
    ...timestampedFileNameCandidates(base, at, ".md", Math.max(tries - 1, 1)),
  ].slice(0, Math.max(tries, 1));
}

/**
 * 書き出して、置いた場所を返す。
 *
 * **`mode: "create"`（新規作成）だけを使う。** 作者が同じ名前のファイルを
 * 手で置いていることもあるので、あるものには一切触らず次の候補へ譲る。
 */
export async function writeAudienceExport(
  directory: string,
  audience: ExportAudience,
  chapter: number | null,
  content: string,
  at: Date = new Date()
): Promise<string> {
  await vscode.workspace.fs.createDirectory(path.toUri(directory));

  for (const name of exportFileNameCandidates(audience, chapter, at)) {
    const target = path.join(directory, name);
    try {
      await vscode.workspace.fs.stat(path.toUri(target));
    } catch {
      // 読めない＝まだ無い。ここへ書く
      await atomicWriteFile(target, new TextEncoder().encode(content), {
        mode: "create",
      });
      return target;
    }
  }
  throw new Error("書き出し先の名前を決められませんでした。");
}

export async function exportSettingsForAudience(
  work: WorkEntry
): Promise<void> {
  const audience = await askAudience();
  if (!audience) return;

  const data = await loadExportData(work);
  if (!data) return;

  const chapter = await askChapter(latestKnownChapter(data));
  if (chapter === "cancelled") return;

  const content = buildExportMarkdown(audience, data, {
    workTitle: work.title,
    authorName: await readAuthorName(work),
    chapter,
    at: new Date(),
  });

  const config = await readWorkConfig(work);
  const settingsDir = workPaths(work, config).settings;

  let target: string;
  try {
    target = await writeAudienceExport(
      settingsDir,
      audience,
      chapter,
      content
    );
  } catch (error) {
    await vscode.window.showErrorMessage(
      "設定資料を書き出せませんでした。" +
        (error instanceof Error ? error.message : String(error))
    );
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `${AUDIENCE_PROFILES[audience].label}の設定資料を ${path.basename(target)} へ書き出しました。` +
      "含めた項目・含めなかった項目はファイルの冒頭に書いてあります。",
    "開く"
  );
  if (action === "開く") {
    await vscode.commands.executeCommand("vscode.open", path.toUri(target));
  }
}

/** 提供先の型を選んでもらう。**説明を必ず添える**（型の名前だけでは選べない） */
async function askAudience(): Promise<ExportAudience | undefined> {
  const items = EXPORT_AUDIENCES.map((id) => ({
    label: AUDIENCE_PROFILES[id].label,
    detail: AUDIENCE_PROFILES[id].description,
    id,
  }));
  const picked = await vscode.window.showQuickPick(
    [...items, cancelItem()],
    {
      title: "誰に渡す資料ですか",
      placeHolder: "提供先によって、出す項目が変わります",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return (picked as (typeof items)[number]).id;
}

/**
 * どこまでの情報を入れるかを訊く。
 *
 * `"cancelled"` は取りやめ、`null` は全話ぶん。**「全話」と「まだ選んでいない」
 * を同じ値にしない**——取りやめたのに全話ぶんを書き出しては困る。
 */
async function askChapter(
  latest: number | null
): Promise<number | null | "cancelled"> {
  const all = { label: "全話ぶん", detail: "いま資料にあることを全部入れます" };
  const upTo = {
    label: "第N話までの情報だけ",
    detail: "先の話で分かったことを外します（ネタバレを避けたいとき）",
  };
  const picked = await vscode.window.showQuickPick([all, upTo, cancelItem()], {
    title: "どこまでの情報を入れますか",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked)) return "cancelled";
  if (picked === all) return null;

  const answer = await askText({
    title: "第何話までの情報を入れますか",
    prompt: "その話までに書かれたことだけを資料にします。",
    value: latest === null ? "" : String(latest),
    validateInput: (value) => {
      const number = Number(value.trim());
      if (!Number.isSafeInteger(number) || number < 1) {
        return "1以上の整数で入れてください。";
      }
      return undefined;
    },
  });
  if (answer === undefined) return "cancelled";
  return Number(answer.trim());
}

/**
 * 資料が知っている最後の話数。入力欄の初期値に使う。
 *
 * **本文は読まない。** 話数を知るためだけに全話を読み直すのは重いうえ、
 * ここで要るのは「だいたい最新」の目安である（作者はそのまま確定させても、
 * 書き換えてもよい）。
 */
function latestKnownChapter(data: SettingsExportData): number | null {
  const chapters = [
    ...data.characters.flatMap((record) => record.appearedChapters),
    ...data.locations.flatMap((record) => record.appearedChapters),
    ...data.abilities.flatMap((record) => record.appearedChapters),
    ...data.organizations.flatMap((record) => record.appearedChapters),
    ...data.world.flatMap((record) => record.appearedChapters),
  ].filter((at) => Number.isFinite(at));
  return chapters.length > 0 ? Math.max(...chapters) : null;
}

/**
 * 書き出す元の資料を読む。
 *
 * **壊れたJSONがあるときは書き出さない。** 欠けた資料をそのまま人へ渡すと、
 * 受け取った側は欠けていることに気づけない（`generateSettingsDocs` と
 * 同じ判断である）。
 */
async function loadExportData(
  work: WorkEntry
): Promise<SettingsExportData | undefined> {
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
    await vscode.window.showErrorMessage(
      "読み込めない設定ファイルがあるため、書き出しませんでした。" +
        "欠けたまま渡すと、足りないことに相手が気づけないためです。（" +
        errors.map((error) => error.file).join("・") +
        "）"
    );
    return undefined;
  }

  return {
    characters: loadedCharacters.characters,
    locations: loadedLocations.records,
    abilities: loadedAbilities.records,
    abilitySystem: await new AbilitySystemStore(work).load(),
    organizations: loadedOrganizations.records,
    world: loadedWorld.records,
    // 項目の定義が読めなくても書き出す。追加項目の欄が出ないだけである
    customFields: await new CustomFieldStore(work).loadFields(),
  };
}

/**
 * 作者名。本の設定（`設定/book/book.json`）に入っていれば使う。
 *
 * **無くても書き出しは止めない。** 頭書きの1行が出ないだけである。
 */
async function readAuthorName(work: WorkEntry): Promise<string | null> {
  try {
    const book = await new BookStore(work).load();
    return book.author.trim() || null;
  } catch {
    return null;
  }
}
