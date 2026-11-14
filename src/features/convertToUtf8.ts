import * as vscode from "vscode";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import {
  convertTextFileToUtf8,
  decodeBytes,
  hasUnsavedChanges,
  sameFilePath,
  type WriteTextFileResult,
} from "../core/textFile";
import { planUtf8Conversion } from "../core/sjisToUtf8";
import {
  describeSkipped,
  describeUtf8Confirm,
  listNames,
  planUtf8Targets,
  shiftJisCandidates,
  type Utf8Candidate,
  type Utf8ConvertTarget,
} from "../core/utf8ConvertPlan";
import { UTF8_CONVERT_BUTTON } from "../core/utf8ConvertHint";
import { logFailure, logLine, logStep, useLogFile } from "../core/logger";
import { manualActor, recordEdit } from "../core/actorContext";
import { editHistoryFile } from "../core/editHistoryFormat";
import { withCancellableProgress } from "../views/progress";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { whenNoticePicked } from "../views/notify";
import { openManuscriptFile } from "./manuscriptTab";

/**
 * 原稿を Shift_JIS から UTF-8 に変換する（設計書5.4.2、0.149.0）。
 *
 * 作者の指示（2026-11-09）：「知らせる時は、原稿の文字コード変換を案内してください」。
 * Shift_JIS の原稿には、♡・絵文字など書けない字がある。UTF-8 にすれば、その字もそのまま書ける。
 *
 * ## 自動では変えない
 *
 * 読んだままの文字コードで書き戻す決まり（5.4.2）はそのまま。変えるのは**作者がこの操作を
 * 押したときだけ**で、そのときも何話を変えるかを窓で見せてから訊く（改行の統一と同じ）。
 *
 * ## 本文は1字も変えない
 *
 * 書き込みは `convertTextFileToUtf8`（本文の書き戻しと同じ関所と「控え→削除→作り直し」）。
 * 字と改行のバイトはそのまま（`sjisToUtf8.ts`）。
 *
 * ## 1話ずつ。失敗しても残りは進める
 *
 * 1話の書き込みは「控えを残してから作り直す」ので、失敗した話は元のまま残る（半端な話はできない）。
 * 作品の中で Shift_JIS と UTF-8 の話が混ざるのは、変える前からある普通の状態なので、
 * 失敗や中止で残りを止めずに、変えた話・変えなかった話を最後に並べて知らせる。
 */

/** 押す場所から渡ってくる「この原稿」 */
export interface Utf8ConvertRequest {
  work: WorkEntry;
  /** 「この話だけ」の候補。作品一覧の話・知らせのボタン・前に出ているタブから */
  focusPath?: string;
}

/** 開いている文書が UTF-8 で読み直されるのを待つ上限 */
const REOPEN_WAIT_MS = 3000;
const REOPEN_POLL_MS = 200;
const REOPEN_BUTTON = "タブを閉じて開き直す";

export async function convertToUtf8(request: Utf8ConvertRequest): Promise<void> {
  const { work } = request;
  useLogFile(work.folderPath);

  const read = await readCandidates(work, request.focusPath);
  if (read === undefined) return; // 中止
  const { candidates, focusIsEpisode } = read;

  const focus = request.focusPath
    ? candidates.find((candidate) => sameFilePath(candidate.filePath, request.focusPath ?? ""))
    : undefined;
  // 「作品の Shift_JIS の話すべて」に、話でないファイル（plot.md など）は入れない
  const sjis = shiftJisCandidates(candidates).filter(
    (candidate) => focusIsEpisode || candidate !== focus
  );
  if (sjis.length === 0 && !(focus && focus.encoding === "shift_jis")) {
    void vscode.window.showInformationMessage(
      focus && focus.encoding !== undefined
        ? `「${focus.name}」はすでに UTF-8 です。この作品に Shift_JIS の話はありません。`
        : "この作品に Shift_JIS の話はありません。"
    );
    return;
  }

  const scope = await pickScope(focus, sjis, focusIsEpisode);
  if (!scope) return;

  const plan = planUtf8Targets(candidates, scope);
  if (plan.targets.length === 0) {
    const skipped = describeSkipped(plan);
    void vscode.window.showWarningMessage(
      `UTF-8 に変換できる話がありませんでした。${skipped}`
    );
    return;
  }

  const confirm = describeUtf8Confirm(plan);
  // 右クリックした話がもう UTF-8 なら、残りの Shift_JIS の話を候補にしたことを先に言う（何も起きないと思わせない）
  const already =
    focus && focus.encoding !== undefined && focus.encoding !== "shift_jis"
      ? `「${focus.name}」はすでに UTF-8 です。この作品の Shift_JIS の話を変えますか。\n\n`
      : "";
  const picked = await vscode.window.showWarningMessage(
    confirm.message,
    { modal: true, detail: already + confirm.detail },
    UTF8_CONVERT_BUTTON
  );
  if (picked !== UTF8_CONVERT_BUTTON) return;

  await convertAll(work, plan.targets, plan);
}

/**
 * 作品の話（と、名指しされたファイル）を読む。中止されたら undefined。
 * `focusIsEpisode` は、名指しされたファイルが作品の話か（plot.md などは話でない）
 */
async function readCandidates(
  work: WorkEntry,
  focusPath: string | undefined
): Promise<{ candidates: Utf8Candidate[]; focusIsEpisode: boolean } | undefined> {
  const { episodes } = await scanWork(work);
  const filePaths = episodes.map((episode) => episode.filePath);
  // 知らせから名指しされたファイル（plot.md など、話でないもの）も「この原稿」として扱う
  const focusIsEpisode =
    focusPath === undefined || filePaths.some((filePath) => sameFilePath(filePath, focusPath));
  if (focusPath && !focusIsEpisode) filePaths.push(focusPath);

  return withCancellableProgress("原稿の文字コードを調べています…", async (progress, token) => {
    const candidates: Utf8Candidate[] = [];
    let index = 0;
    for (const filePath of filePaths) {
      if (token.isCancellationRequested) return undefined;
      progress.report({ message: `${path.basename(filePath)}（${++index}/${filePaths.length}）` });
      candidates.push(await readCandidate(filePath));
    }
    return { candidates, focusIsEpisode };
  });
}

async function readCandidate(filePath: string): Promise<Utf8Candidate> {
  const uri = path.toUri(filePath);
  const name = path.basename(filePath);
  const settingShiftJis =
    vscode.workspace.getConfiguration("files", uri).get<string>("encoding") === "shiftjis";
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const read = decodeBytes(bytes);
    // BOM の有無はここでは決めない（窓の前に、作品のほかの話と合わせて決める）
    const plan = planUtf8Conversion(bytes, { bom: false });
    return {
      filePath,
      name,
      encoding: read.encoding,
      plan: plan.kind === "convert" ? "convert" : plan.reason,
      hash: read.hash,
      dirty: hasUnsavedChanges(filePath),
      settingShiftJis,
    };
  } catch (error) {
    logLine(`原稿の文字コードを調べられませんでした（${name}）：${error instanceof Error ? error.message : String(error)}`);
    return { filePath, name, encoding: undefined, plan: "read_failed", hash: "", dirty: false, settingShiftJis };
  }
}

/**
 * 「この話だけ」か「作品の Shift_JIS の話すべて」か。選ぶ意味が無いとき（この話が無い・
 * Shift_JIS の話がこの話だけ）は訊かない——そのあとの確かめの窓に、何話を変えるかが出る
 */
async function pickScope(
  focus: Utf8Candidate | undefined,
  sjis: readonly Utf8Candidate[],
  focusIsEpisode: boolean
): Promise<readonly Utf8Candidate[] | undefined> {
  const focusIsSjis = focus !== undefined && focus.encoding === "shift_jis";
  if (!focusIsSjis) return sjis;
  const others = sjis.filter((candidate) => candidate !== focus);
  if (others.length === 0) return [focus];

  const items = [
    {
      label: focusIsEpisode ? "この話だけ" : "このファイルだけ",
      description: focus.name,
      scope: [focus] as readonly Utf8Candidate[],
    },
    {
      label: "作品の Shift_JIS の話すべて",
      description: `${sjis.length}話`,
      scope: sjis,
    },
  ];
  const picked = await showQuickPickKeepingFocus([...items, cancelItem()], {
    title: "原稿 UTF-8 変換",
    placeHolder: "どの話を UTF-8 にしますか",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !("scope" in picked)) return undefined;
  return picked.scope;
}

interface Converted {
  target: Utf8ConvertTarget;
  /** 変える前に読んだ本文（LF）。開いている文書が読み直されたかを比べる */
  text: string;
}

interface Failed {
  name: string;
  reason: string;
}

async function convertAll(
  work: WorkEntry,
  targets: readonly Utf8ConvertTarget[],
  plan: Parameters<typeof describeSkipped>[0]
): Promise<void> {
  const done: Converted[] = [];
  const failed: Failed[] = [];
  /*
    **書く前から、文書の中身が変わった知らせを聞いておく。** VS Code がディスクの変化を拾って
    読み直したかは、1.90 ではこの知らせでしか分からない。読み直す前の文書の本文は変える前の
    本文そのものなので、本文を比べるだけでは「読み直されて正しい」と見分けられない
  */
  const changed = new Set<string>();
  const listening = vscode.workspace.onDidChangeTextDocument((event) => {
    changed.add(path.pathKeyForComparison(path.fromUri(event.document.uri)));
  });
  try {
    const cancelled = await convertEach(work, targets, done, failed);
    const stale = await reloadOpenDocuments(done, changed);
    report(work, done, failed, plan, cancelled ? targets.length - done.length - failed.length : 0);
    if (stale.length > 0) warnStale(work, stale);
  } finally {
    listening.dispose();
  }
}

/** 1話ずつ変える。中止されたら true */
async function convertEach(
  work: WorkEntry,
  targets: readonly Utf8ConvertTarget[],
  done: Converted[],
  failed: Failed[]
): Promise<boolean> {
  let cancelled = false;
  await withCancellableProgress("原稿を UTF-8 に変換しています…", async (progress, token) => {
    let index = 0;
    for (const target of targets) {
      if (token.isCancellationRequested) {
        cancelled = true;
        break;
      }
      progress.report({ message: `${target.name}（${++index}/${targets.length}）` });

      // 窓を見ているあいだに変わっていないか。照合は書き込みの中でも2回する（ここは本文を控えるため）
      let text: string;
      try {
        const read = decodeBytes(await vscode.workspace.fs.readFile(path.toUri(target.filePath)));
        if (read.hash !== target.hash) {
          failed.push({ name: target.name, reason: "調べたあとに、ほかの場所から変更されました" });
          continue;
        }
        text = read.text;
      } catch (error) {
        failed.push({ name: target.name, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }

      const result = await convertTextFileToUtf8(target.filePath, target.hash, { bom: target.bom });
      if (!result.ok) {
        failed.push({ name: target.name, reason: describeConvertFailure(result) });
        continue;
      }
      done.push({ target, text });
      /*
        **編集履歴に残す**（改行の統一と同じ。設計書5.6）。文字コードの変換は**ファイルの全バイトを
        書き換える**ので、残さないと、あとで差分を見た人が「全行が変わったが誰が何をしたのか」
        分からない。1話ずつ残す（どの話を触ったかが履歴から読めるように）
      */
      await recordEdit(work, {
        actor: manualActor(),
        action: "文字コードを変えた",
        file: editHistoryFile(work.folderPath, target.filePath),
        detail: `Shift_JIS → UTF-8${target.bom ? "（BOM 付き）" : ""}`,
      });
    }
  });
  return cancelled;
}

/**
 * 開いている文書を UTF-8 で読み直させ、読み直されたかを確かめる。まだ古い文字コードのままの
 * 文書（化けて見えている）の場所を返す。
 *
 * VS Code は、ディスクが変わった文書（保存していない変更が無いもの）を自分で読み直す。
 * そのとき、作者が「エンコード付きで再度開く」で Shift_JIS を選んでいた文書は、
 * UTF-8 になったバイトをまだ Shift_JIS として読む。新しい VS Code には文字コードを
 * 指定して開き直す口（`openTextDocument` の `encoding`）があるので、それを使う。
 * VS Code 1.90 にはこの口が無い（指定は無視される）ので、本文を比べて確かめるだけにする。
 *
 * **化けたまま打って保存すると、化けた字が原稿になる**ので、確かめて知らせる。
 * 原稿エディターも同じ文書を読んでいるので、文書が読み直されれば画面も追う。
 */
async function reloadOpenDocuments(
  done: readonly Converted[],
  changed: ReadonlySet<string>
): Promise<string[]> {
  const open = done
    .map((entry) => ({
      entry,
      document: vscode.workspace.textDocuments.find((document) =>
        sameFilePath(path.fromUri(document.uri), entry.target.filePath)
      ),
    }))
    .filter((pair): pair is { entry: Converted; document: vscode.TextDocument } => pair.document !== undefined);
  if (open.length === 0) return [];

  for (const { entry, document } of open) {
    if (!hasEncodingApi(document)) continue;
    try {
      await vscode.workspace.openTextDocument(document.uri, {
        encoding: entry.target.bom ? "utf8bom" : "utf8",
      });
    } catch (error) {
      logLine(
        `UTF-8 で開き直せませんでした（${entry.target.name}）：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const matches = (document: vscode.TextDocument, text: string): boolean =>
    document.getText().replace(/\r\n?/g, "\n") === text;
  /*
    **本文が同じでも、すぐには「済んだ」としない**（読み直す前の文書も同じ本文のため）。
    読み直しが済んだとみなすのは、文字コードの欄がある版では欄が UTF-8 になったとき、
    無い版（1.90）では中身が変わった知らせが来たとき。どちらも来なければ待ち時間いっぱいまで
    待ってから比べる（正しく読み直されると本文が変わらず、知らせが来ないことがある）。
    1.90 では、待ち時間のあとに読み直されて化けることまでは確かめられない
  */
  const settled = ({ entry, document }: { entry: Converted; document: vscode.TextDocument }): boolean =>
    hasEncodingApi(document)
      ? isUtf8Encoding(document)
      : changed.has(path.pathKeyForComparison(entry.target.filePath));
  const deadline = Date.now() + REOPEN_WAIT_MS;
  while (!open.every(settled) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REOPEN_POLL_MS));
  }
  return open
    .filter(
      ({ entry, document }) =>
        !matches(document, entry.text) || (hasEncodingApi(document) && !isUtf8Encoding(document))
    )
    .map(({ entry }) => entry.target.filePath);
}

/** 文書の文字コードが UTF-8 か（VS Code の名前で utf8・utf8bom） */
function isUtf8Encoding(document: vscode.TextDocument): boolean {
  const encoding = (document as { encoding?: unknown }).encoding;
  return encoding === "utf8" || encoding === "utf8bom";
}

/** 文書が文字コードの欄を持つか（VS Code 1.90 には無い。型は新しい版のもの） */
function hasEncodingApi(document: vscode.TextDocument): boolean {
  return typeof (document as { encoding?: unknown }).encoding === "string";
}

function report(
  work: WorkEntry,
  done: readonly Converted[],
  failed: readonly Failed[],
  skipped: Parameters<typeof describeSkipped>[0],
  leftByCancel: number
): void {
  // 作品のログファイルへ向ける（待っているあいだに書き先が変わっていることがある）
  useLogFile(work.folderPath);
  if (done.length > 0) logStep(`原稿を UTF-8 に変換した: ${done.length}話`);
  for (const entry of failed) {
    logFailure("原稿 UTF-8 変換", { ファイル: entry.name, 詳細: entry.reason });
  }

  // **届いていないことを先に**（実装ルールの「失敗を含む知らせは、届いていないことを先に書く」）
  const notes: string[] = [];
  if (failed.length > 0) {
    notes.push(
      `${failed.length}話は変換できず、Shift_JIS のままです：` +
        failed.map((entry) => `${entry.name}（${entry.reason}）`).join("、") +
        "。"
    );
  }
  if (leftByCancel > 0) notes.push(`途中で止めたので、${leftByCancel}話は Shift_JIS のままです。`);
  notes.push(`${done.length}話を UTF-8 に変換しました。`);
  const skippedLine = describeSkipped(skipped);
  if (skippedLine) notes.push(skippedLine.replace("変えずに飛ばします", "変えずに飛ばしました"));

  const message = notes.join("");
  if (failed.length > 0 || leftByCancel > 0) void vscode.window.showWarningMessage(message);
  else void vscode.window.showInformationMessage(message);
}

/** まだ古い文字コードで開いている話を知らせる。押されたら、そのタブを閉じて開き直す */
function warnStale(work: WorkEntry, filePaths: readonly string[]): void {
  const names = filePaths.map((filePath) => path.basename(filePath));
  const message =
    `開いている${names.length}話が、まだ Shift_JIS のまま表示されています（字が化けて見えます）。` +
    "打たずにタブを閉じて、開き直してください。原稿のファイルは UTF-8 になっています。" +
    // 古い VS Code（1.90）は、タブを閉じても文字コードを覚えていて化けたまま開くことがある。対応の下限の版なので、
    // 別の道で開き直す作りは持たず、VS Code ごと開き直す案内に留める（作者の答え 2026-11-13「知らせで案内」）
    "開き直しても字が化けて見えるときは、VS Code を一度閉じて開き直してください。\n" +
    listNames(names);
  whenNoticePicked(
    vscode.window.showWarningMessage(message, REOPEN_BUTTON),
    (picked) => (picked === REOPEN_BUTTON ? closeAndReopen(filePaths) : undefined),
    { label: "原稿 UTF-8 変換", workFolder: work.folderPath }
  );
}

/**
 * タブを閉じて、同じ列・同じ画面（ふつうのエディター／原稿エディター）で開き直す。
 * 閉じるのは VS Code の普通の閉じ方（保存していない変更があれば、作者が選べる）
 */
async function closeAndReopen(filePaths: readonly string[]): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
    const input: unknown = tab.input;
    const uri =
      input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
    return uri !== undefined && filePaths.some((filePath) => sameFilePath(path.fromUri(uri), filePath));
  });
  const reopen = tabs.map((tab) => ({
    column: tab.group.viewColumn,
    input: tab.input as vscode.TabInputText | vscode.TabInputCustom,
  }));
  if (tabs.length > 0 && !(await vscode.window.tabGroups.close(tabs))) return;
  for (const { column, input } of reopen) {
    if (input instanceof vscode.TabInputCustom) {
      // 原稿を開く道は1本（`openManuscriptFile`）。閉じたあとなので、同じ入口・同じ列で新しく開く
      await openManuscriptFile(input.uri, input.viewType, column);
    } else {
      await vscode.window.showTextDocument(input.uri, { viewColumn: column, preview: false });
    }
  }
}

function describeConvertFailure(result: Extract<WriteTextFileResult, { ok: false }>): string {
  switch (result.reason) {
    case "unsaved_changes":
      return "保存していない変更があります";
    case "conflict_markers":
      return "競合の印（<<<<<<<）が残っています";
    case "modified_externally":
      return "調べたあとに、ほかの場所から変更されました";
    case "editor_locked":
      return result.detail ?? "編集者が校閲中です";
    case "encoding_error":
      return result.detail ?? "Shift_JIS として読めませんでした";
    case "path_conflict":
      return result.detail ?? "書き込めませんでした";
  }
}
