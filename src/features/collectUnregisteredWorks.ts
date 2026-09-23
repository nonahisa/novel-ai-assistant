// ログの書き先：作品が定まらない——まだ登録していない作品を探す操作なので、
// 向ける先の作品フォルダーが無い
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { isEditorMode } from "../core/actorContext";
import { canRunProcesses } from "../core/runtime";
import { logFailure } from "../core/logger";
import {
  describeUnregistered,
  findUnregisteredWorks,
  foldNotified,
  unnotifiedFolders,
  type FoundWork,
  type RepoRootResolver,
} from "../core/unregisteredWorks";
import { registerAll } from "./addCollection";
import { withProgress } from "../views/progress";

/**
 * 書庫にあるのに登録されていない作品を拾う（設計書6.97.4）。
 *
 * **OSのフォルダー選びを通さない道である。** 書庫の場所は登録済み作品から
 * 割り出せるので、作者に選ばせる必要が無い（判断は
 * `core/unregisteredWorks.ts`。ここは画面と登録だけ）。
 *
 * ## 「フォルダから追加」は消さない
 *
 * 書庫の**外**から作品を入れる道として要る。こちらはそれより上に並べて、
 * **既定の道**にする。
 *
 * ## 勝手に登録しない
 *
 * 起動したときの知らせは1行だけで、**押さなければ何も起きない。**
 * 書庫に置いてあるだけで作品として扱ってよいとは限らない（下書き置き場、
 * 参考資料、別の道具のフォルダーかもしれない）。
 */

/** 知らせた覚え（`globalState`。**この機械で**知らせたかどうかの話） */
export const NOTIFIED_KEY = "novelai.library.unregisteredNotified";

/** 知らせに添えるボタン。文言はここ1か所に置く */
export const COLLECT_ACTION_LABEL = "書庫から拾う";

/** この操作のコマンドID。知らせのボタンから呼ぶ */
export const COLLECT_COMMAND = "novelai.collectUnregisteredWorks";

/**
 * gitの根を教えてもらう口を作る。
 *
 * **`core/git.ts` は動的に読む。** あちらは `node:child_process` を静的に
 * import しているので、静的に指すとブラウザ版の束へ混ざる（規則7）。
 * 外部プロセスを起動できない環境では `undefined` を返し、書庫の割り出しは
 * 親フォルダーだけで行う。
 */
async function repoRootResolver(): Promise<RepoRootResolver | undefined> {
  if (!canRunProcesses()) return undefined;
  try {
    const { runGit } = await import("../core/git.js");
    return async (folderPath: string) => {
      const result = await runGit(
        ["rev-parse", "--show-toplevel"],
        folderPath,
        10_000
      );
      if (result.code !== 0) return undefined;
      const root = result.stdout.trim();
      return root.length > 0 ? root : undefined;
    };
  } catch {
    // gitが読めなくても、親フォルダーからの割り出しだけで用は足りる
    return undefined;
  }
}

/**
 * 書庫の未登録の作品を拾う（操作の本体）。
 *
 * @param onRegistered 1件以上登録できたときに呼ぶ（一覧の作り直し）
 */
export async function collectUnregisteredWorks(
  registry: WorkRegistry,
  onRegistered: () => void
): Promise<void> {
  // 編集部は1作品だけを見る建前なので、まとめて登録する道を通さない（5.7.4）
  if (isEditorMode()) {
    await vscode.window.showWarningMessage(
      "編集者モードでは、書庫からまとめて登録することはできません。"
    );
    return;
  }

  const works = registry.list();
  if (works.length === 0) {
    // **書庫の場所は登録済み作品から割り出している。** 手がかりが無いことを
    // 「ありません」で片付けると、作者は探し方が悪いのだと思ってしまう
    await vscode.window.showInformationMessage(
      "まだ作品が登録されていないため、書庫の場所が分かりません。" +
        "「フォルダー登録」で1作品を登録すると、次からは書庫の中を探せます。"
    );
    return;
  }

  const repoRootOf = await repoRootResolver();
  const found = await withProgress("書庫の中を探しています…", () =>
    findUnregisteredWorks(works, { repoRootOf })
  );

  // **1件も無ければ、そう言う。** 黙って何も起きないのが最悪である
  if (found.length === 0) {
    await vscode.window.showInformationMessage(
      "書庫に未登録の作品はありません。"
    );
    return;
  }

  const chosen = await pickWorks(found);
  if (!chosen || chosen.length === 0) return;

  const added = await registerAll(
    registry,
    chosen.map((work) => ({
      folderPath: work.folderPath,
      title: work.title,
      hasConfig: work.hasConfig,
      alreadyRegistered: false,
    }))
  );
  if (added.length > 0) onRegistered();
}

/**
 * どれを登録するかを選んでもらう。
 *
 * **設定ファイルのあるものだけを、あらかじめ選んだ状態にする。** それは
 * この拡張機能で作った作品だと確実に言えるからである。無いものは
 * 「本文のフォルダーがある」だけで拾っているので、**下書き置き場や参考資料が
 * 混じりうる**——出しはするが、選ぶかどうかは作者に決めてもらう。
 */
async function pickWorks(
  found: readonly FoundWork[]
): Promise<FoundWork[] | undefined> {
  const chosen = await vscode.window.showQuickPick(
    found.map((work) => ({
      label: work.title,
      description: describeAmount(work),
      detail: work.folderPath,
      picked: work.hasConfig,
      work,
    })),
    {
      canPickMany: true,
      title: `書庫に、まだ登録していない作品が${found.length}件あります`,
      placeHolder: "登録するものにチェックを入れて、OKを押してください",
      ignoreFocusOut: true,
    }
  );
  return chosen?.map((item) => item.work);
}

/** 一覧の右に出す、分量と出どころの目安 */
function describeAmount(work: FoundWork): string {
  const amount = work.episodeCount > 0 ? `${work.episodeCount}話` : "本文なし";
  return work.hasConfig ? amount : `${amount}・設定ファイルなし`;
}

/**
 * 起動したときに、1行だけ知らせる。
 *
 * **毎回は言わない。** 一度知らせたものは覚えておき、**新しく増えたときだけ**
 * もう一度知らせる（畳み方の判断は `core/unregisteredWorks.ts`）。
 *
 * **gitの根は見に行かない。** 起動のたびに作品の数だけ `git` を起動すること
 * になるためで、親フォルダーからの割り出しだけで作者の形（書庫の直下に作品が
 * 並ぶ）は拾える。取りこぼしたとしても、操作の側（`collectUnregisteredWorks`）
 * では見に行くので、押せば出てくる。
 */
export async function noticeUnregisteredWorks(
  context: vscode.ExtensionContext,
  works: readonly WorkEntry[]
): Promise<void> {
  if (isEditorMode()) return;
  if (works.length === 0) return;

  const found = await findUnregisteredWorks(works);
  const notified = context.globalState.get<string[]>(NOTIFIED_KEY, []);
  const fresh = unnotifiedFolders(found, notified);

  // 覚えは、見つかっている分だけに詰め直す（登録済みになったものは忘れる）
  await context.globalState.update(NOTIFIED_KEY, foldNotified(found));
  if (fresh.length === 0) return;

  const action = await vscode.window.showInformationMessage(
    describeUnregistered(found),
    COLLECT_ACTION_LABEL
  );
  if (action !== COLLECT_ACTION_LABEL) return;
  await vscode.commands.executeCommand(COLLECT_COMMAND);
}

/**
 * 起動時の知らせを、登録簿の整備の隣から呼ぶための包み。
 *
 * **失敗しても起動を巻き添えにしない。** 書庫の走査はフォルダーの中を読むので、
 * ドライブが繋がっていない・権限が無いといった理由で失敗しうる。
 */
export function noticeUnregisteredWorksSafely(
  context: vscode.ExtensionContext,
  works: readonly WorkEntry[]
): void {
  void (async () => {
    try {
      await noticeUnregisteredWorks(context, works);
    } catch (error) {
      logFailure("書庫の未登録作品の確認", {
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
