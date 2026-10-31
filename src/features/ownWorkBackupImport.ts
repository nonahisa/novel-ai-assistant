import * as vscode from "vscode";
import * as path from "../core/paths";
import { isEditorMode } from "../core/actorContext";
import {
  BACKUP_DROP_MAX_BYTES,
  isBackupFileName,
  tooLargeMessage,
} from "../core/backupFileKinds";
import { backupIdentityOf } from "../core/backupMatch";
import { logFailure, logStep, useLogFile } from "../core/logger";
import {
  checkBackupAgainstOwnWork,
  ownWorkLabel,
  type UnregisteredOwnWork,
} from "../core/unregisteredOwnWorks";
import { inspectWorkBackup, WorkZipError, type WorkZipInspection } from "../core/workZip";
import { messageOf } from "../core/errorMessage";
import { postingSiteInfo } from "../models/posting";
import type { WorkEntry } from "../models/types";
import { withProgress } from "../views/progress";
import type { KnownSiteWork, PickedBackup } from "./importWorkFromZip";

/**
 * 「未登録の自分の作品」の枠へ、バックアップを取り込む（作者の指示 2026-11-01）。
 *
 * **ZIP を読む部品をここで読み込む**ので、起動のときには読み込まない
 * （枠の操作が押されてから `features/unregisteredOwnWorks.ts` が動的 import する）。
 *
 * ## 流れ
 *
 * 1. 読んで確かめる（`inspectWorkBackup`。この時点では1文字も書かない）
 * 2. **中身を枠の作品と照らす**（サイト・なろうならNコード・題。`checkBackupAgainstOwnWork`）。
 *    食い違えば止めて訊く——取り違えた作品の ZIP を新しい作品にして、そこへ枠の作品ID を
 *    書くと、あとから届く読者の反応が別の作品へ混ざる
 * 3. 6.99 の取り込み（`importWorkFromZip`）へ渡す。**サイトと作品ID は枠から引き継ぎ**、
 *    訊き直さない（台帳へ書くのはサイトが同じときだけ。`notePostingSite`）
 *
 * 落としたファイルは消さない・動かさない（読むだけ）。
 */

/** 新しい作品として取り込む口（`extension.ts` の登録の道を持っている側が渡す） */
export type ImportOwnWorkAsNew = (
  picked: PickedBackup,
  known: KnownSiteWork
) => Promise<WorkEntry | undefined>;

/** 照らして食い違ったときの、取り込みへ進むボタン */
export const IMPORT_ANYWAY_LABEL = "それでも取り込む";

/**
 * @returns 登録した作品。取りやめ・断り・失敗なら undefined（枠は残す）
 */
export async function importOwnWorkBackup(
  entry: UnregisteredOwnWork,
  source: { readonly fileName: string; readonly bytes: Uint8Array },
  importAsNew: ImportOwnWorkAsNew
): Promise<WorkEntry | undefined> {
  // 作品が決まるまでは保管庫の記録へ（相談パネルの受け口と同じ理由。設計書6.99.7）
  useLogFile(undefined);
  const label = ownWorkLabel(entry);
  const fileName = path.basename(source.fileName);

  // 編集部は取り込まない（設計書5.6。「バックアップ取込」と同じ）
  if (isEditorMode()) {
    void vscode.window.showWarningMessage(
      "編集者モードでは、バックアップの取り込みはできません（作者の環境で行ってください）。"
    );
    return undefined;
  }
  if (!isBackupFileName(fileName)) {
    void vscode.window.showWarningMessage(
      `「${fileName}」はバックアップとして読めません。投稿サイトからダウンロードした ZIP か .txt を渡してください。`
    );
    return undefined;
  }
  if (source.bytes.byteLength > BACKUP_DROP_MAX_BYTES) {
    void vscode.window.showWarningMessage(tooLargeMessage(fileName));
    return undefined;
  }

  let inspection: WorkZipInspection;
  try {
    inspection = await withProgress("バックアップの中を見ています…", async () =>
      inspectWorkBackup(source.bytes, fileName)
    );
  } catch (error) {
    if (error instanceof WorkZipError) {
      await vscode.window.showWarningMessage(error.message, {
        modal: true,
        ...(error.detail ? { detail: error.detail } : {}),
      });
      return undefined;
    }
    logFailure("未登録の自分の作品：バックアップの読み取り", {
      ファイル: fileName,
      詳細: messageOf(error),
    });
    void vscode.window.showErrorMessage(`バックアップを読めませんでした：${messageOf(error)}`);
    return undefined;
  }

  const identity = backupIdentityOf(inspection);
  const check = checkBackupAgainstOwnWork(identity, entry);
  logStep(
    `未登録の自分の作品「${label}」（${postingSiteInfo(entry.site).label} ${entry.workId}）へ` +
      `「${fileName}」を照らしました：${check.ok ? "合っています" : check.reason}`
  );
  if (!check.ok) {
    const answer = await vscode.window.showWarningMessage(
      `「${fileName}」は「${label}」のバックアップではないかもしれません。`,
      {
        modal: true,
        detail: [
          check.reason,
          "",
          "取り込むと、新しい作品として登録します（落としたファイルは消しません）。",
          "サイトが違うときは、枠の作品ID を新しい作品へ書き込みません。",
        ].join("\n"),
      },
      IMPORT_ANYWAY_LABEL
    );
    if (answer !== IMPORT_ANYWAY_LABEL) {
      logStep(`「${label}」への取り込みを取りやめました（照らして食い違ったため）`);
      return undefined;
    }
  }

  return importAsNew(
    { fileName, inspection },
    { site: entry.site, workId: entry.workId }
  );
}
