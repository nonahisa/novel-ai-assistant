import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { logFailure, useLogFile } from "../core/logger";
import type { WorkRegistry } from "../core/workRegistry";
import {
  scanCollection,
  describeScan,
  type WorkCandidate,
} from "../core/workCollection";
import { isEditorMode } from "../core/actorContext";
import { withProgress } from "../views/progress";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 書庫をまとめて登録する（設計書5.7）。
 *
 * **これまでは作品を1つずつ登録するしかなかった。** 作者は1つのリポジトリに
 * 複数の作品を並べて運用しており、別の環境で開くたびに、フォルダーを選ぶ操作を
 * 作品の数だけ繰り返していた（2026-08-21、作者の指摘）。
 *
 * ## ボタンを増やさない
 *
 * 「書庫を追加」という入口を別に作ると、作者は**押す前にどちらか決めねば
 * ならない。** フォルダーの中身を見れば機械が判断できることを、人に聞くのは
 * 筋が悪い。そこで既存の入口（フォルダーから追加・GitHubから追加）が、
 * 渡されたフォルダーを見て**作品か書庫かを自分で見分ける**ようにした。
 *
 * ## 編集者モードでは働かせない
 *
 * 編集部は1作品だけを見る建前なので、まとめて登録する道を通さない（5.7.4）。
 * **ただしこれは取り違え防止であって、守りではない。** 守るのはGitHubの
 * 招待範囲のほうである。
 */

export type CollectionResult =
  /** 書庫として扱い、登録まで済ませた（呼び出し側は何もしない） */
  | { handled: true; added: WorkEntry[] }
  /** 書庫ではなかった。呼び出し側がこれまで通り1作品として扱う */
  | { handled: false };

export interface CollectionOptions {
  /**
   * 呼び出し側が「これは1作品である」と知っているか。
   *
   * **知っているなら訊いてはいけない**（2026-09-19、作者の実機確認）。
   * ZIPからの取り込み（6.99）は、その作品フォルダーを**自分で作っている**
   * ——`本文/` と `設定/` を置いたのは取り込み自身である。それでも中を
   * 見に行くと、`設定/` があるせいで「作品にも書庫にも見えます」の問いが
   * 出る。しかも既定は「中の1件を登録する」のほうなので、そのままEnterを
   * 押した作者は壊れた登録を受け取る。
   *
   * **知らない入口（フォルダーから追加・GitHubから追加）は渡さない。**
   * あちらは本当に書庫かもしれないので、訊くのが正しい。
   */
  readonly knownSingleWork?: boolean;
}

/**
 * フォルダーが書庫なら、中の作品をまとめて登録する。
 *
 * **書庫でなければ何もせず、判断を呼び出し側へ返す。** 作品そのものだった
 * 場合や、中に作品が見当たらない場合は、これまでの振る舞い（そのフォルダーを
 * 1作品として登録する）を変えない。**入口の意味を変えないための約束である。**
 */
export async function tryRegisterAsCollection(
  registry: WorkRegistry,
  root: string,
  options: CollectionOptions = {}
): Promise<CollectionResult> {
  // **作品だと分かっているなら、探しに行かない。** 中を見て迷う余地を
  // 作らないことが目的なので、走査（`scanCollection`）の前に返す
  if (options.knownSingleWork) return { handled: false };

  // 編集者モードでは、複数作品を抱え込ませない
  if (isEditorMode()) return { handled: false };

  // 比べ方は登録簿の重複の見方と同じにする（`folderKeyForComparison`。
  // 2026-09-24）。`path.normalize` の完全一致では、ドライブ文字の大小が
  // 違うだけの登録を「未登録」と数え、書庫ごと二重に登録できた
  const registered = new Set(
    registry.list().map((w) => path.folderKeyForComparison(w.folderPath))
  );
  const scan = await withProgress("作品を探しています…", () =>
    scanCollection(root, (folder) =>
      registered.has(path.folderKeyForComparison(folder))
    )
  );

  // **どちらとも取れるときは、作者に決めてもらう**（設計書5.7.6）。
  // 書庫の直下に設定ファイルが残っていることがあり、機械には決められない
  if (scan.kind === "work_with_children") {
    const choice = await askWhichToRegister(root, scan.works.length);
    if (choice === "cancel") return { handled: true, added: [] };
    // 1作品として登録するなら、これまでの道（呼び出し側）へ返す
    if (choice === "self") return { handled: false };
  }

  // 作品そのもの・作品が無い・読めない、はすべて呼び出し側へ返す。
  // 「読めない」を書庫として扱うと、取り寄せは済んでいるのに
  // 何も登録されないまま終わってしまう
  if (scan.kind !== "collection" && scan.kind !== "work_with_children") {
    return { handled: false };
  }

  const fresh = scan.works.filter((w) => !w.alreadyRegistered);
  if (fresh.length === 0) {
    void vscode.window.showInformationMessage(
      `「${path.basename(root)}」の中の${scan.works.length}件は、すべて登録済みです。`
    );
    return { handled: true, added: [] };
  }

  // **黙って全部登録しない。** 書庫には、作者が作品として扱っていない
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
  // 書庫だと分かっている以上、その全体を1作品にするのは作者の意図ではない
  if (!chosen) return { handled: true, added: [] };
  if (chosen.length === 0) return { handled: true, added: [] };

  const added = await registerAll(
    registry,
    chosen.map((item) => item.work)
  );
  return { handled: true, added };
}

/**
 * 作品にも書庫にも見えるとき、どちらとして登録するかを聞く。
 *
 * **中の作品をまとめて登録するほうを先に置く。** 書庫の直下に設定ファイルが
 * 残っているのは過去の名残であることが多く、作者が本当にやりたいのは
 * 中の作品を扱うことだからである（2026-08-22、作者の環境で判明）。
 */
async function askWhichToRegister(
  root: string,
  childCount: number
): Promise<"children" | "self" | "cancel"> {
  const name = path.basename(root);
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(library) 中の${childCount}件の作品を登録する`,
        detail: "書庫として扱います（こちらが多い形です）",
        choice: "children" as const,
      },
      {
        label: `$(book) 「${name}」そのものを1作品として登録する`,
        detail: "このフォルダー全体で1つの作品として扱います",
        choice: "self" as const,
      },
      cancelItem(),
    ],
    {
      title: `「${name}」は作品にも書庫にも見えます`,
      placeHolder: "どちらとして登録しますか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("choice" in picked)) return "cancel";
  return picked.choice;
}

/**
 * 選ばれた作品を順に登録する。
 *
 * **1件失敗しても残りを続ける。** 途中で止めると、どこまで登録できたのかが
 * 作者に分からなくなる。失敗は集めて最後にまとめて報告する。
 *
 * **外へ出してある**（0.69.x）。「未登録の作品を探す」
 * （`collectUnregisteredWorks.ts`、設計書6.97.4）も同じ登録の仕方を通す
 * ——**写しを作ると、失敗の報告の仕方が2通りになる。**
 */
export async function registerAll(
  registry: WorkRegistry,
  works: WorkCandidate[]
): Promise<WorkEntry[]> {
  const added: WorkEntry[] = [];
  const failed: string[] = [];
  // **最初の失敗の理由を画面に出す。** 名前だけ並べても次の手が決まらず、
  // 作者はログを開くところから始めることになる（2026-08-22）
  let firstReason: string | undefined;

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
        const detail = error instanceof Error ? error.message : String(error);
        // その作品のログへ残す（向けないと出力チャンネル止まり）
        useLogFile(work.folderPath);
        logFailure("書庫からの登録", { 作品: work.title, 詳細: detail });
        failed.push(work.title);
        firstReason ??= detail;
      }
    }
  });

  const reasonNote = firstReason ? `\n理由: ${firstReason}` : "";

  if (added.length > 0 && failed.length === 0) {
    void vscode.window.showInformationMessage(
      `${added.length}件の作品を登録しました。`
    );
  } else if (added.length > 0) {
    const action = await vscode.window.showWarningMessage(
      `${added.length}件を登録しました。${failed.length}件は登録できませんでした（${failed.join("、")}）。${reasonNote}`,
      "ログを表示",
      "閉じる"
    );
    if (action === "ログを表示") {
      await vscode.commands.executeCommand("novelai.showLog");
    }
  } else {
    const action = await vscode.window.showErrorMessage(
      `登録できませんでした（${failed.join("、")}）。${reasonNote}`,
      "ログを表示",
      "閉じる"
    );
    if (action === "ログを表示") {
      await vscode.commands.executeCommand("novelai.showLog");
    }
  }

  return added;
}
