import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { logFailure } from "../core/logger";
import type { WorkRegistry } from "../core/workRegistry";
import {
  scanCollection,
  describeScan,
  type WorkCandidate,
} from "../core/workCollection";
import { isEditorMode } from "../core/actorContext";
import { withProgress } from "../views/progress";

/**
 * 作品集をまとめて登録する（設計書5.7）。
 *
 * **これまでは作品を1つずつ登録するしかなかった。** 作者は1つのリポジトリに
 * 複数の作品を並べて運用しており、別の環境で開くたびに、フォルダーを選ぶ操作を
 * 作品の数だけ繰り返していた（2026-08-21、作者の指摘）。
 *
 * ## ボタンを増やさない
 *
 * 「作品集を追加」という入口を別に作ると、作者は**押す前にどちらか決めねば
 * ならない。** フォルダーの中身を見れば機械が判断できることを、人に聞くのは
 * 筋が悪い。そこで既存の入口（フォルダーから追加・GitHubから追加）が、
 * 渡されたフォルダーを見て**作品か作品集かを自分で見分ける**ようにした。
 *
 * ## 編集者モードでは働かせない
 *
 * 編集部は1作品だけを見る建前なので、まとめて登録する道を通さない（5.7.4）。
 * **ただしこれは取り違え防止であって、守りではない。** 守るのはGitHubの
 * 招待範囲のほうである。
 */

export type CollectionResult =
  /** 作品集として扱い、登録まで済ませた（呼び出し側は何もしない） */
  | { handled: true; added: WorkEntry[] }
  /** 作品集ではなかった。呼び出し側がこれまで通り1作品として扱う */
  | { handled: false };

/**
 * フォルダーが作品集なら、中の作品をまとめて登録する。
 *
 * **作品集でなければ何もせず、判断を呼び出し側へ返す。** 作品そのものだった
 * 場合や、中に作品が見当たらない場合は、これまでの振る舞い（そのフォルダーを
 * 1作品として登録する）を変えない。**入口の意味を変えないための約束である。**
 */
export async function tryRegisterAsCollection(
  registry: WorkRegistry,
  root: string
): Promise<CollectionResult> {
  // 編集者モードでは、複数作品を抱え込ませない
  if (isEditorMode()) return { handled: false };

  const registered = new Set(
    registry.list().map((w) => path.normalize(w.folderPath))
  );
  const scan = await withProgress("作品を探しています…", () =>
    scanCollection(root, (folder) => registered.has(folder))
  );

  // 作品そのもの・作品が無い・読めない、はすべて呼び出し側へ返す。
  // 「読めない」を作品集として扱うと、取り寄せは済んでいるのに
  // 何も登録されないまま終わってしまう
  if (scan.kind !== "collection") return { handled: false };

  const fresh = scan.works.filter((w) => !w.alreadyRegistered);
  if (fresh.length === 0) {
    void vscode.window.showInformationMessage(
      `「${path.basename(root)}」の中の${scan.works.length}件は、すべて登録済みです。`
    );
    return { handled: true, added: [] };
  }

  // **黙って全部登録しない。** 作品集には、作者が作品として扱っていない
  // フォルダー（下書き置き場など）が混じることがある
  const chosen = await vscode.window.showQuickPick(
    fresh.map((work) => ({
      label: work.title,
      description: work.hasConfig ? undefined : "設定ファイルなし",
      detail: work.folderPath,
      picked: true,
      work,
    })),
    {
      canPickMany: true,
      title: `${describeScan(scan, root)}登録するものを選んでください`,
      placeHolder: "外したいもののチェックを外して、OKを押してください",
      ignoreFocusOut: true,
    }
  );
  // 取り消したときは、1作品としての登録へ落とさない。
  // 作品集だと分かっている以上、その全体を1作品にするのは作者の意図ではない
  if (!chosen) return { handled: true, added: [] };
  if (chosen.length === 0) return { handled: true, added: [] };

  const added = await registerAll(
    registry,
    chosen.map((item) => item.work)
  );
  return { handled: true, added };
}

/**
 * 選ばれた作品を順に登録する。
 *
 * **1件失敗しても残りを続ける。** 途中で止めると、どこまで登録できたのかが
 * 作者に分からなくなる。失敗は集めて最後にまとめて報告する。
 */
async function registerAll(
  registry: WorkRegistry,
  works: WorkCandidate[]
): Promise<WorkEntry[]> {
  const added: WorkEntry[] = [];
  const failed: string[] = [];

  await withProgress("作品を登録しています…", async () => {
    for (const work of works) {
      try {
        const entry = await registry.addExisting(work.folderPath, work.title);
        if (entry) {
          added.push(entry);
        } else {
          failed.push(work.title);
        }
      } catch (error) {
        logFailure("作品集からの登録", {
          作品: work.title,
          詳細: error instanceof Error ? error.message : String(error),
        });
        failed.push(work.title);
      }
    }
  });

  if (added.length > 0 && failed.length === 0) {
    void vscode.window.showInformationMessage(
      `${added.length}件の作品を登録しました。`
    );
  } else if (added.length > 0) {
    const action = await vscode.window.showWarningMessage(
      `${added.length}件を登録しました。${failed.length}件は登録できませんでした（${failed.join("、")}）。`,
      "ログを表示",
      "閉じる"
    );
    if (action === "ログを表示") {
      await vscode.commands.executeCommand("novelai.showLog");
    }
  } else {
    void vscode.window.showErrorMessage(
      `登録できませんでした（${failed.join("、")}）。`
    );
  }

  return added;
}
