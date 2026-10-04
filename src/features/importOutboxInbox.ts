import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import {
  hasUnsavedChanges,
  writeTextFilePreservingFormat,
  type WriteTextFailureReason,
} from "../core/textFile";
import {
  importOutboxRecords,
  jsonLinesAddition,
  type OutboxImportIo,
  type OutboxImportOutcome,
  type OutboxRecord,
} from "../core/outboxImport";
import {
  OUTBOX_INBOX_DIR,
  OUTBOX_INBOX_DONE,
  describeInboxImport,
  doneNameFor,
  parseInboxFile,
  pendingInboxNames,
} from "../core/outboxInbox";
import { logFailure, logLine, logStep, showLog, useLogFile } from "../core/logger";
import { findingsRetentionDays } from "./findingStore";

/**
 * ［原稿箱を取り込む］（設計書6.115「GitHub 経由」。作者の裁定 2026-10-04
 * 「取り込みボタンが欲しいです」）。
 *
 * 出先のページが GitHub の作品のリポジトリへ置いた受け取り箱
 * （`.aiwriter/inbox/*.json`）を読み、MCP の `outbox.import` と**同じ決まり**
 * （`core/outboxImport.ts`）で作品へ入れる。済んだ箱は `inbox/done/` へ移し、
 * 次の同期で GitHub へ送られる（`git add -A` が移動を記録する）。
 *
 * - **箱の中身はすべて持ち主の判断として扱う。** GitHub に書けるのは書く権限のある人
 *   だけで、編集部とは共有しない裁定（2026-10-03）
 * - 本文の書き戻しは `writeTextFilePreservingFormat`（実装ルール1。読み込み時のハッシュ照合・
 *   文字コードと改行の保持・回復先への退避）
 * - **壊れた箱は直さずに残す**（実装ルール2）。理由を知らせる
 * - 自動では取り込まない。同期で箱が届いたら知らせるだけで、押すのは作者
 */

/** 取り込みの結果（試験と、知らせの組み立てに使う） */
export interface InboxImportReport {
  /** 読んだ箱の名前 */
  boxes: string[];
  /** 読めなかった箱と理由（受け取り箱に残した） */
  broken: Array<{ name: string; reason: string }>;
  outcome: OutboxImportOutcome;
  /** `done/` へ移せなかった箱と理由 */
  unmoved: Array<{ name: string; reason: string }>;
}

function inboxDir(work: WorkEntry): string {
  return path.join(work.folderPath, ...OUTBOX_INBOX_DIR.split("/"));
}

/** 受け取り箱の中の、取り込み待ちの箱の名前。箱が無ければ空 */
export async function listPendingInbox(work: WorkEntry): Promise<string[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(inboxDir(work)));
  } catch {
    return [];
  }
  return pendingInboxNames(
    entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name)
  );
}

/**
 * 届いている記録の数（同期のあとの知らせに使う）。読めない箱は数えない
 */
export async function countPendingInboxRecords(work: WorkEntry): Promise<number> {
  let total = 0;
  for (const name of await listPendingInbox(work)) {
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(path.join(inboxDir(work), name)));
      const parsed = parseInboxFile(new TextDecoder().decode(bytes));
      if (parsed.ok) total += parsed.records.length;
    } catch {
      // 読めない箱は数えない（取り込みのときに理由を出す）
    }
  }
  return total;
}

/** 書き戻しの失敗を、作者に読める理由へ */
function describeWriteFailure(reason: WriteTextFailureReason, detail?: string): string {
  switch (reason) {
    case "modified_externally":
      return "パソコンの本文が変わっています（読んだあとに書き換えられました）。";
    case "unsaved_changes":
      return "VS Code で開いたまま保存していない変更があります。保存してから取り込み直してください。";
    case "conflict_markers":
      return "Gitの競合マーカーが残っているため、書きませんでした。先に解消してください。";
    case "encoding_error":
      return "この文字コード（Shift_JIS）で表せない文字が含まれているため、書きませんでした。";
    case "path_conflict":
      return `書き込めませんでした。${detail ?? ""}`.trim();
  }
}

/**
 * VS Code の読み書きで組んだ取り込みの口（`OutboxImportIo`）。
 * 本文の一覧は作品一覧と同じ走査（`scanWork`）から取る
 */
export function vscodeOutboxIo(work: WorkEntry): OutboxImportIo {
  const at = (relative: string) => path.join(work.folderPath, ...relative.split("/"));
  return {
    async readText(relative) {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(path.toUri(at(relative))));
      } catch {
        return undefined;
      }
    },
    async listBodyFiles() {
      const { episodes } = await scanWork(work);
      return episodes.map((episode) =>
        path.relative(work.folderPath, episode.filePath).split("\\").join("/")
      );
    },
    async readBytes(relative) {
      return vscode.workspace.fs.readFile(path.toUri(at(relative)));
    },
    async writeBody(relative, newText, original) {
      const written = await writeTextFilePreservingFormat(at(relative), newText, original, original.hash);
      if (written.ok) return { ok: true };
      return {
        ok: false,
        changed: written.reason === "modified_externally",
        reason: describeWriteFailure(written.reason, written.detail),
      };
    },
    async appendJsonLines(relative, values) {
      if (values.length === 0) return;
      const target = at(relative);
      await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
      const uri = path.toUri(target);
      let existing: Uint8Array;
      try {
        existing = await vscode.workspace.fs.readFile(uri);
      } catch {
        existing = new Uint8Array();
      }
      // 追記だけ（`FindingStore` と同じ形。前の行は書き換えない）
      const added = new TextEncoder().encode(jsonLinesAddition(existing, values));
      const merged = new Uint8Array(existing.byteLength + added.byteLength);
      merged.set(existing, 0);
      merged.set(added, existing.byteLength);
      await vscode.workspace.fs.writeFile(uri, merged);
    },
  };
}

/**
 * 受け取り箱を読んで取り込み、済んだ箱を `done/` へ移す（画面の知らせは出さない）。
 *
 * **全部の箱の記録を1回にまとめて渡す**——メモを先・採否をあとに入れる、同じ指摘は
 * いちばん新しい1件だけ、の決まりを箱をまたいで効かせるため。
 */
export async function runInboxImport(
  work: WorkEntry,
  options: { io?: OutboxImportIo; retentionDays?: number; now?: Date } = {}
): Promise<InboxImportReport> {
  const names = await listPendingInbox(work);
  const broken: InboxImportReport["broken"] = [];
  const readable: string[] = [];
  const records: OutboxRecord[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(path.toUri(path.join(inboxDir(work), name)))
      );
    } catch (error) {
      broken.push({ name, reason: `読めませんでした（${error instanceof Error ? error.message : String(error)}）` });
      continue;
    }
    const parsed = parseInboxFile(text);
    if (!parsed.ok) {
      broken.push({ name, reason: parsed.reason });
      continue;
    }
    readable.push(name);
    records.push(...parsed.records);
  }

  // 記録が1つも無ければ、本文の走査も置き場の読みもしない（空の箱は移すだけ）
  const outcome: OutboxImportOutcome =
    records.length === 0
      ? { results: [], importedCount: 0, alreadyCount: 0, refusedCount: 0 }
      : await importOutboxRecords(options.io ?? vscodeOutboxIo(work), {
          // 受け取り箱の中身は、すべて持ち主の判断（6.115）
          isOwner: () => true,
          records,
          retentionDays: options.retentionDays,
          now: options.now,
        });

  const unmoved = await moveToDone(work, readable);
  return { boxes: readable, broken, outcome, unmoved };
}

/**
 * 読めた箱を `inbox/done/` へ移す。**移し先に同じ名前があれば別の名前にする**
 * （既存のファイルを上書きしない）。移せなくても取り込みは済んでいる——
 * 次に押したときは「入れ済み」で返るだけなので、理由を知らせて残す
 */
async function moveToDone(
  work: WorkEntry,
  names: readonly string[]
): Promise<Array<{ name: string; reason: string }>> {
  const unmoved: Array<{ name: string; reason: string }> = [];
  if (names.length === 0) return unmoved;
  const doneDir = path.join(inboxDir(work), OUTBOX_INBOX_DONE);
  await vscode.workspace.fs.createDirectory(path.toUri(doneDir));
  const taken = new Set<string>();
  try {
    for (const [name] of await vscode.workspace.fs.readDirectory(path.toUri(doneDir))) taken.add(name);
  } catch {
    // 空なら何も無い
  }
  for (const name of names) {
    const target = doneNameFor(name, taken);
    try {
      await vscode.workspace.fs.rename(
        path.toUri(path.join(inboxDir(work), name)),
        path.toUri(path.join(doneDir, target)),
        { overwrite: false }
      );
      taken.add(target);
    } catch (error) {
      unmoved.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return unmoved;
}

/**
 * 開いたまま保存していない話があるか。あれば、取り込みの前に作者に保存してもらう
 * （`writeTextFilePreservingFormat` は書きかけを壊さないよう断るが、断ったまま箱を
 * `done/` へ移すと、作者が保存したあとに入れ直せない）
 */
function dirtyBodyDocuments(work: WorkEntry): vscode.TextDocument[] {
  return vscode.workspace.textDocuments.filter(
    (document) =>
      document.isDirty &&
      path.isPathInside(work.folderPath, path.fromUri(document.uri)) &&
      hasUnsavedChanges(path.fromUri(document.uri))
  );
}

/** ［原稿箱を取り込む］の本体（詳細メニュー・コマンドパレット・同期のあとの知らせから） */
export async function importOutboxInbox(work: WorkEntry): Promise<void> {
  const names = await listPendingInbox(work);
  if (names.length === 0) {
    vscode.window.showInformationMessage(
      `「${work.title}」の原稿箱に、取り込み待ちのものはありません。` +
        "出先のページで［パソコンへ送る］を押したあと、GitHub と同期すると届きます。"
    );
    return;
  }

  const dirty = dirtyBodyDocuments(work);
  if (dirty.length > 0) {
    const SAVE = "保存して取り込む";
    const answer = await vscode.window.showWarningMessage(
      `「${work.title}」に、保存していない変更があります（${dirty.length}件）。` +
        "取り込みは本文を書き換えるので、先に保存します。",
      { modal: true },
      SAVE
    );
    if (answer !== SAVE) return;
    for (const document of dirty) {
      if (!(await document.save())) {
        vscode.window.showWarningMessage("保存できなかった話があるため、取り込みを止めました。");
        return;
      }
    }
  }

  useLogFile(work.folderPath);
  let report: InboxImportReport;
  try {
    report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "原稿箱を取り込んでいます…" },
      () => runInboxImport(work, { retentionDays: findingsRetentionDays() })
    );
  } catch (error) {
    logFailure("原稿箱の取り込みに失敗", {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
    const action = await vscode.window.showErrorMessage(
      `「${work.title}」の原稿箱を取り込めませんでした。`,
      "ログを表示"
    );
    if (action === "ログを表示") showLog();
    return;
  }

  logInboxReport(work, report);
  const summary = describeInboxImport(report.outcome, report.broken.length);
  const trouble =
    report.outcome.refusedCount > 0 || report.broken.length > 0 || report.unmoved.length > 0;
  const tail = report.outcome.importedCount > 0 ? "提案パネル・校正メモパネルは、開き直すと反映されます。" : "";
  const shown = trouble
    ? vscode.window.showWarningMessage(`「${work.title}」：${summary}${tail}`, "理由を見る")
    : vscode.window.showInformationMessage(`「${work.title}」：${summary}${tail}`);
  // 押されるのを待たない（取り込みはもう終わっている）
  void Promise.resolve(shown).then((picked) => {
    if (picked === "理由を見る") showLog();
  });
}

/** 操作ログ（作品の `logs/`）に、1件ごとの結果を残す */
function logInboxReport(work: WorkEntry, report: InboxImportReport): void {
  logStep(
    `原稿箱の取り込み（${work.title}）：箱 ${report.boxes.length}つ／` +
      `入れた ${report.outcome.importedCount}件・入れ済み ${report.outcome.alreadyCount}件・` +
      `断った ${report.outcome.refusedCount}件`
  );
  for (const item of report.outcome.results) {
    if (item.status === "refused") logLine(`  断った：${item.id}　${item.reason}`);
    else if (item.status === "imported") logLine(`  入れた：${item.id}　${item.reason}`);
  }
  for (const box of report.broken) {
    logFailure("原稿箱の箱を読めなかった（受け取り箱に残した）", { 作品: work.title, 箱: box.name, 理由: box.reason });
  }
  for (const box of report.unmoved) {
    logFailure("原稿箱の箱を done へ移せなかった", { 作品: work.title, 箱: box.name, 理由: box.reason });
  }
}
