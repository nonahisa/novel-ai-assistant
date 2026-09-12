import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import {
  EOL_MISMATCH_REASON,
  auditEol,
  describeEolAudit,
  eolLabel,
  planEolUnify,
  planFileEolWrite,
  type EolAuditEntry,
} from "../core/eolAudit";
import {
  hasUnsavedChanges,
  readTextFile,
  writeTextFilePreservingFormat,
  type WriteTextFileResult,
} from "../core/textFile";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { withCancellableProgress } from "../views/progress";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 作品の改行コードを揃える（設計書5.4.2）。
 *
 * 作者の依頼（2026-09-12）：「改行コードが違う場合、他のツールで不具合が
 * 起こる可能性を指摘しつつ、変換を促したほうが良いのではないでしょうか」。
 *
 * ## 自動では変えない
 *
 * 読んだままの改行で書き戻すという決まり（5.4.2）は**そのままである**。
 * 同期にも保存にもAIの適用にも、改行を変える処理は足していない。
 * 変えるのは**作者がこの操作を押したときだけ**で、そのときも
 * 「何件が変わるのか」を見せてから訊く。
 *
 * ## 本文は1文字も変えない
 *
 * 書き戻しに渡すのは、読んだままの本文（`content.text`）そのもの。
 * 文字コードも末尾改行も読んだ値を引き継ぎ、変わるのは行末のバイトだけ
 * （`writeTextFilePreservingFormat` の `rewriteEol`）。書き込みの手順は
 * これまでどおり「回復先へ退避 → 新規作成」を通る——`atomicWriteFile` を
 * 直に呼ぶ処理は、ここには無い。
 */

/** 飛ばした理由。作者への報告で数えるために持つ */
interface Skipped {
  filePath: string;
  reason: string;
}

export async function unifyEol(work: WorkEntry): Promise<void> {
  const { episodes } = await scanWork(work);
  const entries: EolAuditEntry[] = episodes.map((episode) => ({
    filePath: episode.filePath,
    eol: episode.eol ?? null,
    hasMixedEol: episode.hasMixedEol ?? false,
  }));

  const audit = auditEol(entries);
  if (audit.majority === null) {
    void vscode.window.showInformationMessage(
      "改行コードを調べられる本文が見つかりませんでした。"
    );
    return;
  }
  if (audit.differing.length === 0) {
    void vscode.window.showInformationMessage(
      `この作品の改行コードは揃っています（${describeEolAudit(audit)}）`
    );
    return;
  }

  const target = await pickTarget(entries, audit.majority, audit);
  if (!target) return;

  const targets = planEolUnify(entries, target);
  if (targets.length === 0) {
    void vscode.window.showInformationMessage(
      `すでに全部 ${eolLabel(target)} です。`
    );
    return;
  }

  await convertAll(work, targets, target);
}

/**
 * どちらへ揃えるかを選んでもらう。**多数派を先頭に置く。**
 *
 * 少数派へ揃える道も残すのは、作者が使っている外のツールが
 * CRLF しか受け付けないことがあるためである（こちらから決めない）。
 */
async function pickTarget(
  entries: readonly EolAuditEntry[],
  majority: "\n" | "\r\n",
  audit: ReturnType<typeof auditEol>
): Promise<"\n" | "\r\n" | undefined> {
  const others: Array<"\n" | "\r\n"> = majority === "\n" ? ["\r\n"] : ["\n"];
  const choices: Array<"\n" | "\r\n"> = [majority, ...others];

  const items = choices.map((eol) => {
    const count = planEolUnify(entries, eol).length;
    return {
      label: `${eolLabel(eol)} に揃える`,
      description:
        `${count}件を変えます` +
        // **LF を勧める理由を、選ぶ場で言う。** あとの報告に書いても遅い
        (eol === "\n" ? "（GitHub・他のツールと相性がよい）" : ""),
      detail: EOL_MISMATCH_REASON,
      eol,
    };
  });

  const picked = await vscode.window.showQuickPick(
    [...items, cancelItem()],
    {
      title: "改行コードを揃える",
      placeHolder: describeEolAudit(audit),
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("eol" in picked)) return undefined;
  return picked.eol;
}

/** 1件ずつ書き換える。**1件失敗しても残りは進める** */
async function convertAll(
  work: WorkEntry,
  targets: readonly string[],
  target: "\n" | "\r\n"
): Promise<void> {
  const done: string[] = [];
  const skipped: Skipped[] = [];
  const failed: Skipped[] = [];

  await withCancellableProgress(
    `改行コードを ${eolLabel(target)} に揃えています…`,
    async (progress, token) => {
      let index = 0;
      for (const filePath of targets) {
        if (token.isCancellationRequested) break;
        progress.report({
          message: `${path.basename(filePath)}（${++index}/${targets.length}）`,
        });

        // **開いたまま直していない本文には触れない。** 退避→作り直しで
        // 書くので、打ちかけを抱えたファイルを消すと行き場が無くなる
        if (hasUnsavedChanges(filePath)) {
          skipped.push({ filePath, reason: "未保存の変更があります" });
          continue;
        }

        let content;
        try {
          content = await readTextFile(filePath);
        } catch (error) {
          failed.push({
            filePath,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        const plan = planFileEolWrite(content, target);
        if (plan.kind === "skip") {
          // 競合の印が残っているものだけを数える。走査のあとに
          // 揃っていた（already）ものは、報告に出す理由が無い
          if (plan.reason === "conflict_markers") {
            skipped.push({ filePath, reason: "競合の印（<<<<<<<）が残っています" });
          }
          continue;
        }

        const result = await writeTextFilePreservingFormat(
          filePath,
          plan.text,
          plan.format,
          plan.expectedHash,
          // **これが要る。** 既定では「変わらなかったところの元バイト」を
          // そのまま置くので、本文が同じままだと1バイトも変わらない
          { rewriteEol: true }
        );
        if (result.ok) done.push(filePath);
        else failed.push({ filePath, reason: describeWriteFailure(result) });
      }
    }
  );

  report(work, done, skipped, failed, target);
}

function report(
  work: WorkEntry,
  done: readonly string[],
  skipped: readonly Skipped[],
  failed: readonly Skipped[],
  target: "\n" | "\r\n"
): void {
  // 作品のログファイルへ向ける（出力チャンネル止まりにしない）
  useLogFile(work.folderPath);
  if (done.length > 0) {
    logStep(`改行コードを揃えた: ${done.length}件（${eolLabel(target)}）`);
  }
  for (const entry of [...skipped, ...failed]) {
    logFailure("改行コードを揃える", {
      ファイル: path.basename(entry.filePath),
      詳細: entry.reason,
    });
  }

  const unsaved = skipped.filter((entry) =>
    entry.reason.startsWith("未保存")
  ).length;
  const conflicted = skipped.length - unsaved;

  const notes = [`${done.length}件を ${eolLabel(target)} に揃えました。`];
  if (unsaved > 0 || conflicted > 0) {
    notes.push(`（飛ばした：未保存 ${unsaved}件・競合 ${conflicted}件）`);
  }
  if (failed.length > 0) {
    notes.push(
      `${failed.length}件は書き換えられませんでした：` +
        failed
          .map((entry) => `${path.basename(entry.filePath)}（${entry.reason}）`)
          .join("、")
    );
  }

  const message = notes.join("");
  if (failed.length > 0) void vscode.window.showWarningMessage(message);
  else void vscode.window.showInformationMessage(message);
}

function describeWriteFailure(result: WriteTextFileResult): string {
  if (result.ok) return "";
  switch (result.reason) {
    case "unsaved_changes":
      return "開いたまま直していない変更があります";
    case "conflict_markers":
      return "競合の印（<<<<<<<）が残っています";
    case "modified_externally":
      return "読み込んだあとに、他の場所から変更されました";
    case "encoding_error":
      return "元の文字コードで書き出せませんでした";
    default:
      return result.detail ?? "書き込めませんでした";
  }
}
