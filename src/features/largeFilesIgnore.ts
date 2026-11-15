import * as vscode from "vscode";
import {
  describeTooLargeToRecord,
  findLargeFilesToRecord,
  ignoreRuleFor,
  type LargeFile,
  type SizeOf,
} from "../core/gitLargeFiles";
import type { GitCommandRunner } from "../core/git";
import { appendIgnoreRules } from "../core/workRegistry";
import { logFailure, logStep, showLog, useLogFile } from "../core/logger";
import type { WorkEntry } from "../models/types";
import { whenNoticePicked } from "../views/notify";
import { useSyncLog } from "./syncLog";

/**
 * GitHub に送れない大きさのファイルを記録から外すボタン（設計書5.5.21）。
 * 「すべて同期」の報告と、単独の同期の「取り込む前の記録」が同じものを出す
 */
export const IGNORE_LARGE_FILES_LABEL = ".gitignore に足す";

/**
 * ［.gitignore に足す］を押したときだけ、置き場の根の .gitignore の末尾へ道を足す。
 *
 * **ファイルは動かさない・消さない。** 作者が書いた行は変えない（`appendIgnoreRules`）。
 * 足したあと、もう一度同期すれば、そのファイルを除いて記録される。
 * 同期でない所（変更の記録・最初の記録・復元）から押されたときは、`again` で次の一手を言い替える
 */
export async function ignoreLargeFiles(
  root: string,
  files: readonly LargeFile[],
  works: readonly WorkEntry[],
  again = "もう一度同期してください。"
): Promise<void> {
  // 押されるのは報告のあとなので、ログの向きを置き場へ向け直す（書庫なら書庫のログ。設計書5.7.9）
  await useSyncLog(root, works);
  try {
    await appendIgnoreRules(
      root,
      files.map((one) => ignoreRuleFor(one.path))
    );
    logStep(
      `GitHub に送れない大きさのファイルを .gitignore に足した（${root}／${files
        .map((one) => one.path)
        .join("、")}）`
    );
    void vscode.window.showInformationMessage(
      `${files.length}件を .gitignore に足しました。${again}`
    );
  } catch (error) {
    logFailure(".gitignore に足せなかった", {
      置き場: root,
      詳細: error instanceof Error ? error.message : String(error),
    });
    void vscode.window.showWarningMessage(
      ".gitignore に足せませんでした（詳しくはログにあります）。"
    );
  }
}

/** 記録の前に大きさで止めたときの、知らせとログの出し方 */
export interface TooLargeNoticeOptions {
  /** ログの見出し（どの操作の記録を止めたか。「取り込む前の記録」など） */
  step: string;
  /** 知らせの頭に付ける名前（「「作品」：」の形で付く）。無ければ付けない */
  subject?: string;
  /** ログの付記（作品名・置き場名など）。ファイルの道と大きさはこの部品が足す */
  logFields?: Record<string, string>;
  /** ログを書く前に向ける作品フォルダー。呼び出し側がもう向けていれば省く */
  logFolder?: string;
  /** ［.gitignore に足す］を押したとき、ログを向け直すための登録済みの作品 */
  works: readonly WorkEntry[];
  /** 知らせのボタンが失敗したときの記録の名前（`whenNoticePicked`） */
  label: string;
  /** 道の一覧のあとに足す1行（復元で「戻していない」と言うときなど）。無ければ足さない */
  tail?: string;
  /** ［.gitignore に足す］のあとの次の一手。無ければ「もう一度同期してください。」 */
  again?: string;
  /** 試験で大きさを差し替える */
  sizeOf?: SizeOf;
}

/**
 * GitHub に送れない大きさのファイルがあれば、記録の前に止めて知らせる（設計書5.5.21）。
 * 止めたら true（呼び出し側は記録しないで戻る）。
 *
 * `commitAll` の中に入れないのは、呼び出し元ごとに戻り値と知らせの形が違うため。
 * 単独の同期・最初の記録・変更の記録・復元が同じ知らせを出すので、ここに1つだけ置く。
 *
 * **ボタンの答えは待たない**（`whenNoticePicked`）。同期の旗の中から呼ばれるので、待つと
 * 作者が閉じるまで自動の送り直しが控え続ける。［.gitignore に足す］は、まだ git に
 * 入っていないファイルがあるときだけ出す——記録済みのファイルが大きくなったものは、
 * 足しても次の記録で同じく止まる
 */
export async function stopIfTooLargeToRecord(
  cwd: string,
  run: GitCommandRunner,
  options: TooLargeNoticeOptions
): Promise<boolean> {
  const large = await findLargeFilesToRecord(cwd, run, options.sizeOf);
  if (large.files.length === 0) return false;
  if (options.logFolder !== undefined) useLogFile(options.logFolder);
  logFailure(`${options.step}：GitHub に送れない大きさのファイルがあるので記録しなかった`, {
    ...(options.logFields ?? {}),
    ファイル: large.files.map((one) => `${one.path}（${one.size}バイト）`).join("、"),
  });
  const untracked = large.files.filter((one) => one.untracked);
  const head = options.subject !== undefined ? `「${options.subject}」：` : "";
  whenNoticePicked(
    vscode.window.showWarningMessage(
      `${head}${describeTooLargeToRecord(large.files)}` +
        (options.tail !== undefined ? `\n${options.tail}` : ""),
      ...(untracked.length > 0 ? [IGNORE_LARGE_FILES_LABEL] : []),
      "ログを表示"
    ),
    async (action) => {
      if (action === IGNORE_LARGE_FILES_LABEL) {
        await ignoreLargeFiles(large.root, untracked, options.works, options.again);
      }
      if (action === "ログを表示") showLog();
    },
    { label: options.label, workFolder: options.logFolder ?? options.works[0]?.folderPath }
  );
  return true;
}
