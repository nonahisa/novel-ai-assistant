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
  buildExportDocument,
  renderExportHeaderMarkdown,
  renderExportMarkdown,
  type ExportAudience,
  type SettingsExportData,
} from "../core/settingsExportProfiles";
import { buildExportHtml } from "../core/settingsExportHtml";
import {
  buildExportCsvFiles,
  type ExportCsvFile,
} from "../core/settingsExportCsv";
import { buildExportDocx } from "../core/settingsExportDocx";
import {
  buildExportDiffMarkdown,
  parseSnapshot,
  snapshotOf,
  type ExportSnapshot,
} from "../core/settingsExportDiff";
import {
  TIMESTAMPED_NAME_TRIES,
  timestampedFileNameCandidates,
} from "../core/timestampedFileName";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { canRunProcesses } from "../core/runtime";
import { describeProcessesBlocked } from "../core/processAvailability";
import { openInDefaultApp } from "../core/openExternalFile";
import { logFailure, useLogFile } from "../core/logger";
import type { WorkEntry } from "../models/types";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { revealFolder } from "../views/openDocument";

/**
 * 提供先を選んで書き出す（設計書6.75）。
 *
 * **AIは呼ばない。** 抽出済みのJSONから、提供先の型に合った項目だけを
 * 選んで1つの資料にまとめる。何を出すかの判断は
 * `core/settingsExportProfiles.ts` の表だけが持つ（ここは訊いて書くだけ）。
 *
 * 形式（F6、設計書6.75.1）：Markdown・HTML・CSV・PDF（ブラウザで印刷）・
 * Word・前回との差分。**どの形式も同じ `buildExportDocument` の結果を描く**
 * ので、出す項目は形式によって変わらない。
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
  tries: number = TIMESTAMPED_NAME_TRIES,
  extension: string = ".md",
  suffix: string = ""
): string[] {
  const base = exportFileBaseName(audience, chapter) + suffix;
  return [
    `${base}${extension}`,
    ...timestampedFileNameCandidates(base, at, extension, Math.max(tries - 1, 1)),
  ].slice(0, Math.max(tries, 1));
}

/** 書き出しの名前の付け方。形式ごとに拡張子と添え書きだけが変わる */
export interface ExportNaming {
  /** 点から書く（`.html`）。CSV のフォルダーは空文字 */
  extension?: string;
  /** 基本の名前の後ろに添える（「・前回との差分」など） */
  suffix?: string;
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
  content: string | Uint8Array,
  at: Date = new Date(),
  naming: ExportNaming = {}
): Promise<string> {
  await vscode.workspace.fs.createDirectory(path.toUri(directory));
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;

  const target = await freshTarget(directory, audience, chapter, at, naming);
  await atomicWriteFile(target, bytes, { mode: "create" });
  return target;
}

/** まだ使われていない名前を決める。**あるものには触らない** */
async function freshTarget(
  directory: string,
  audience: ExportAudience,
  chapter: number | null,
  at: Date,
  naming: ExportNaming
): Promise<string> {
  for (const name of exportFileNameCandidates(
    audience,
    chapter,
    at,
    TIMESTAMPED_NAME_TRIES,
    naming.extension ?? ".md",
    naming.suffix ?? ""
  )) {
    const target = path.join(directory, name);
    try {
      await vscode.workspace.fs.stat(path.toUri(target));
    } catch {
      // 読めない＝まだ無い。ここへ書く
      return target;
    }
  }
  throw new Error("書き出し先の名前を決められませんでした。");
}

/**
 * CSV を書き出す。種別ごとのファイルと、頭書きの1枚を、**新しいフォルダー**に
 * まとめて置く。返すのはフォルダーの場所。
 *
 * フォルダーにまとめるのは、5つのファイルの名前をそれぞれ空いている名前に
 * すると、ぶつかったときに時刻がばらけて1組だと分からなくなるため。
 * フォルダー1つ分の名前を決めれば、中の名前は固定でよい。
 *
 * 頭書き（何を含めて何を含めなかったか）を添えるのは、**CSV は表の外に
 * 断り書きを置けない**から。渡された側が「これで全部」と思い込まないように
 * （設計書6.75）。
 */
export async function writeAudienceCsvExport(
  directory: string,
  audience: ExportAudience,
  chapter: number | null,
  files: readonly ExportCsvFile[],
  about: string,
  at: Date = new Date()
): Promise<string> {
  await vscode.workspace.fs.createDirectory(path.toUri(directory));
  const folder = await freshTarget(directory, audience, chapter, at, {
    extension: "",
    suffix: "（CSV）",
  });
  await vscode.workspace.fs.createDirectory(path.toUri(folder));

  const encoder = new TextEncoder();
  await atomicWriteFile(
    path.join(folder, "この資料について.md"),
    encoder.encode(about),
    { mode: "create" }
  );
  for (const file of files) {
    await atomicWriteFile(
      path.join(folder, `${file.label}.csv`),
      encoder.encode(file.content),
      { mode: "create" }
    );
  }
  return folder;
}

/* ──────────────────────────  形式（F6）  ────────────────────────── */

export type ExportFormat = "markdown" | "html" | "csv" | "pdf" | "docx" | "diff";

export interface ExportFormatChoice {
  id: ExportFormat;
  label: string;
  detail: string;
  /** いまの環境で使えないときの理由。使えるなら null */
  blockedReason: string | null;
}

/**
 * 形式の選択肢。**Markdown を先頭に置く**——これまでの書き出しと同じ道を、
 * いちばん手前に残すため。
 *
 * **ブラウザ版で使えない形式も消さない**（実装ルール7）。PDF は組んだ HTML を
 * 手元のブラウザへ渡して印刷させるので、作品がパソコンの中に無いブラウザ版
 * では成り立たない（`novelai.exportPdf` と同じ理由・同じ文言）。理由を添えて
 * 並べ、選ばれたら理由を出して止める。
 *
 * @param canRun 外部の道具を起こせるか（`canRunProcesses()`）。試験から
 *   両側を確かめられるように引数で受ける
 */
export function exportFormatChoices(canRun: boolean): ExportFormatChoice[] {
  return [
    {
      id: "markdown",
      label: "Markdown（.md）",
      detail: "これまでと同じ形式です。VS Code やテキストエディターで読めます",
      blockedReason: null,
    },
    {
      id: "html",
      label: "HTML（.html）",
      detail: "目次と表のついた1枚のページ。ブラウザで開くだけで読めます",
      blockedReason: null,
    },
    {
      id: "csv",
      label: "CSV（表計算ソフト向け）",
      detail: "人物・場所などの種別ごとに1ファイル。Excel で開いても文字化けしません",
      blockedReason: null,
    },
    {
      id: "pdf",
      label: "PDF（ブラウザで印刷）",
      detail:
        "印刷用のページをブラウザで開きます。印刷の送信先を「PDFに保存」にするとPDFになります",
      blockedReason: canRun ? null : describeProcessesBlocked("novelai.exportPdf"),
    },
    {
      id: "docx",
      label: "Word（.docx）",
      detail: "見出しつきの Word 文書。受け取った側が Word で書き込めます",
      blockedReason: null,
    },
    {
      id: "diff",
      label: "前回との差分（.md）",
      detail:
        "この提供先へ前回書き出した資料から、足された・変わった・消えた項目だけを並べます",
      blockedReason: null,
    },
  ];
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

  const format = await askFormat();
  if (!format) return;

  const at = new Date();
  const document = buildExportDocument(audience, data, {
    workTitle: work.title,
    authorName: await readAuthorName(work),
    chapter,
    at,
  });

  const config = await readWorkConfig(work);
  const paths = workPaths(work, config);
  const settingsDir = paths.settings;
  const snapshotFile = snapshotPath(paths.aiwriter, audience);
  const label = AUDIENCE_PROFILES[audience].label;

  // 差分は、控えを上書きする**前に**前回の控えを読んでおく
  const previous =
    format === "diff" ? await readSnapshot(snapshotFile) : undefined;

  let target: string;
  try {
    switch (format) {
      case "markdown":
        target = await writeAudienceExport(
          settingsDir,
          audience,
          chapter,
          renderExportMarkdown(document),
          at
        );
        break;
      case "html":
        target = await writeAudienceExport(
          settingsDir,
          audience,
          chapter,
          buildExportHtml(document),
          at,
          { extension: ".html" }
        );
        break;
      case "docx":
        target = await writeAudienceExport(
          settingsDir,
          audience,
          chapter,
          buildExportDocx(document),
          at,
          { extension: ".docx" }
        );
        break;
      case "csv":
        target = await writeAudienceCsvExport(
          settingsDir,
          audience,
          chapter,
          buildExportCsvFiles(document),
          renderExportHeaderMarkdown(document.header),
          at
        );
        break;
      case "pdf":
        // 印刷用は組み直せるものなので、本文のPDF出力と同じく
        // `.gitignore` 済みの `.aiwriter/exports/` へ置く（履歴を膨らませない）
        target = await writeAudienceExport(
          path.join(paths.aiwriter, "exports"),
          audience,
          chapter,
          buildExportHtml(document),
          at,
          { extension: ".html", suffix: "（印刷用）" }
        );
        break;
      case "diff":
        if (previous === undefined || previous.snapshot === null) {
          // 前回の控えが無ければ比べられない。今回の控えだけ置いて、次回に備える
          await saveSnapshot(work, snapshotFile, snapshotOf(document, at));
          await vscode.window.showInformationMessage(
            (previous?.reason === "broken"
              ? "前回の控えを読めなかったため、"
              : `${label}へ書き出した控えがまだ無いため、`) +
              "差分は作れませんでした。いまの資料を控えたので、次回からは差分を出せます。"
          );
          return;
        }
        target = await writeAudienceExport(
          settingsDir,
          audience,
          chapter,
          buildExportDiffMarkdown(previous.snapshot, snapshotOf(document, at), {
            workTitle: work.title,
          }),
          at,
          { suffix: "・前回との差分" }
        );
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useLogFile(work.folderPath);
    logFailure("設定資料の書き出し", { 作品: work.title, 形式: format, 内容: message });
    await vscode.window.showErrorMessage(
      "設定資料を書き出せませんでした。" + message
    );
    return;
  }

  // **書き出すたびに控える**（差分の書き出しも含む。差分を渡したなら、
  // 次の差分はそこからでよい）。控えに失敗しても、書き出しは済んでいる
  await saveSnapshot(work, snapshotFile, snapshotOf(document, at));

  await announce(format, label, target);
}

/** 書き出したあとの知らせ。形式ごとに次の一手が違う */
async function announce(
  format: ExportFormat,
  label: string,
  target: string
): Promise<void> {
  const name = path.basename(target);
  if (format === "pdf") {
    // 本文のPDF出力（`exportPdf.ts`）と同じ道：ブラウザへ渡して印刷させる
    if (!(await openInDefaultApp(target))) {
      const action = await vscode.window.showWarningMessage(
        "印刷用のファイルは作りましたが、ブラウザを開けませんでした。" +
          `フォルダーの中の ${name} をダブルクリックすると開きます。` +
          "開いたら印刷（Ctrl+P）で送信先を「PDFに保存」にしてください。",
        "フォルダーを開く"
      );
      if (action === "フォルダーを開く") await revealFolder(target);
      return;
    }
    const action = await vscode.window.showInformationMessage(
      `${label}の設定資料をブラウザで開きました。` +
        "印刷（Ctrl+P）で送信先を「PDFに保存」にするとPDFになります。" +
        "種別（人物・場所…）ごとに新しい紙から始まります。",
      "フォルダーを開く"
    );
    if (action === "フォルダーを開く") await revealFolder(target);
    return;
  }

  if (format === "markdown" || format === "diff") {
    const action = await vscode.window.showInformationMessage(
      format === "diff"
        ? `${label}への前回の書き出しとの差分を ${name} へ書き出しました。`
        : `${label}の設定資料を ${name} へ書き出しました。` +
            "含めた項目・含めなかった項目はファイルの冒頭に書いてあります。",
      "開く"
    );
    if (action === "開く") {
      await vscode.commands.executeCommand("vscode.open", path.toUri(target));
    }
    return;
  }

  const detail =
    format === "csv"
      ? "種別ごとの CSV と、含めた項目・含めなかった項目を書いた「この資料について.md」が入っています。"
      : "含めた項目・含めなかった項目は冒頭に書いてあります。";
  const action = await vscode.window.showInformationMessage(
    `${label}の設定資料を ${name} へ書き出しました。${detail}`,
    "フォルダーを開く"
  );
  if (action === "フォルダーを開く") await revealFolder(target);
}

/** 形式を選んでもらう。使えない形式は理由を添えて並べ、選ばれたら止める */
async function askFormat(): Promise<ExportFormat | undefined> {
  const choices = exportFormatChoices(canRunProcesses());
  const items = choices.map((choice) => ({
    label: choice.label,
    description: choice.blockedReason ? "この環境では使えません" : undefined,
    detail: choice.blockedReason ?? choice.detail,
    choice,
  }));
  const picked = await vscode.window.showQuickPick(
    [...items, cancelItem()],
    {
      title: "どの形式で書き出しますか",
      placeHolder: "中身（出す項目）は、どの形式でも同じです",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  const choice = (picked as (typeof items)[number]).choice;
  if (choice.blockedReason) {
    void vscode.window.showWarningMessage(choice.blockedReason);
    return undefined;
  }
  return choice.id;
}

/* ──────────────────────  差分の控え（F6）  ────────────────────── */

/**
 * 控えの置き場。`.aiwriter/settings-exports/<提供先>.json`。
 *
 * **同期する置き場にした**（`.gitignore` の除外に入れていない）。「前回
 * この相手へ何を渡したか」は機械ごとの話ではなく作品の事実なので、
 * ノートPCで書き出したあとに別の機械で差分を取っても同じ前回を指すように。
 */
export function snapshotPath(aiwriterDir: string, audience: ExportAudience): string {
  return path.join(aiwriterDir, SNAPSHOT_DIR, `${audience}.json`);
}

const SNAPSHOT_DIR = "settings-exports";

/**
 * 前回の控えを読む。無ければ `none`、読めなければ `broken`（**直さない**。
 * 今回の書き出しで新しい控えに置き換わる）。
 */
async function readSnapshot(
  file: string
): Promise<{ snapshot: ExportSnapshot | null; reason: "none" | "broken" | null }> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(file));
  } catch {
    return { snapshot: null, reason: "none" };
  }
  const snapshot = parseSnapshot(new TextDecoder().decode(bytes));
  return snapshot ? { snapshot, reason: null } : { snapshot: null, reason: "broken" };
}

/**
 * 控えを置く。**固定の名前へ上書きする**（`atomicWriteFile` の指定なしの経路）。
 * 控えは作者が書くものではなく、毎回この機能が作り直すもので、
 * チャンクキャッシュや履歴と同じ扱いでよい。
 *
 * 失敗しても書き出しは済んでいるので、止めずに知らせだけ出す。
 */
async function saveSnapshot(
  work: WorkEntry,
  file: string,
  snapshot: ExportSnapshot
): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(file)));
    await atomicWriteFile(
      file,
      new TextEncoder().encode(JSON.stringify(snapshot, null, 2) + "\n")
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useLogFile(work.folderPath);
    logFailure("設定資料の書き出しの控え", { 作品: work.title, 内容: message });
    void vscode.window.showWarningMessage(
      "書き出しは済みましたが、次回の差分に使う控えを残せませんでした。" + message
    );
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
