import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { logFailure, logLine, useLogFile } from "../core/logger";
import { FindingStore, findingsRetentionDays } from "./findingStore";

/**
 * 「古い指摘を片づける」（設計書6.96.4）。
 *
 * ## 期限切れは、隠れているだけで在る
 *
 * 保存日数（`novelai.findings.retentionDays`、既定3日）を過ぎた指摘は
 * 一覧に並ばなくなるが、**ファイルからは消えていない**。機械が勝手に
 * 消さないのは、時計がずれていたときや、ノートPCを久しぶりに開いたときに
 * **作者が見る前に消える**のを防ぐためである。
 *
 * だから、消す操作が要る。**それがこれで、`findings.jsonl` を書き直すのは
 * ここだけである**（ほかはすべて追記のみ——同じ行を両方の機械が書き換え
 * ないので、同期の衝突が起きにくい）。
 *
 * ## 先に見せてから訊く
 *
 * 何件消えるかを数えてから確認を取る。消してから件数を告げても、作者は
 * 取り消せない（`.aiwriter/` は同期されるので、消したことも同期される）。
 *
 * ## 先例
 *
 * `features/pruneLogs.ts`（ログの掃除）と同じ考え方だが、**あちらは
 * 機械が自動で片付ける**。こちらは作者が押したときだけ動く——ログは
 * 読まれなくても困らないが、指摘は読まれる前に消えては困る。
 */
export async function pruneFindings(work: WorkEntry): Promise<void> {
  const store = new FindingStore(work);
  const days = findingsRetentionDays();

  if (!(days > 0)) {
    void vscode.window.showInformationMessage(
      "保存日数が無期限（0）になっているため、古い指摘はありません。" +
        "設定の novelai.findings.retentionDays で日数を決めてください。"
    );
    return;
  }

  let expired: number;
  try {
    expired = await store.countExpired(days);
  } catch (error) {
    noteFailure(work, error);
    void vscode.window.showErrorMessage(
      "指摘の置き場を読めませんでした。ログに理由が残っています。"
    );
    return;
  }

  if (expired === 0) {
    void vscode.window.showInformationMessage(
      `「${work.title}」に、${days}日を過ぎた指摘はありません。`
    );
    return;
  }

  /*
    **確認は必ず取る**（実装ルール2）。ここは作者のデータを消す唯一の道で
    あり、押し間違いで消えると戻せない。件数と日数の両方を出す——「3日」と
    しか言わないと、設定を変えた作者が別の日数で消されたと感じる。
  */
  const answer = await vscode.window.showWarningMessage(
    `「${work.title}」の古い指摘 ${expired}件を消します。` +
      `${days}日より前に見つかったもので、いまは一覧に並んでいません。` +
      "消すと元に戻せません。",
    { modal: true },
    "消す"
  );
  if (answer !== "消す") return;

  let removed: number;
  try {
    removed = await store.prune(days);
  } catch (error) {
    noteFailure(work, error);
    void vscode.window.showErrorMessage(
      "古い指摘を片づけられませんでした。ログに理由が残っています。"
    );
    return;
  }

  useLogFile(work.folderPath);
  logLine(`古い指摘を片づけました（${removed}件、${days}日より前）。`);
  void vscode.window.showInformationMessage(
    `古い指摘 ${removed}件を片づけました。`
  );
}

/** 失敗は作品のログへ残す。**鍵になるのは詳細**（件数は画面に出ない） */
function noteFailure(work: WorkEntry, error: unknown): void {
  try {
    useLogFile(work.folderPath);
    logFailure("古い指摘の片づけ", {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // 記録にも残せないなら、できることはもう無い
  }
}
