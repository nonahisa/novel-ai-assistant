import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { logFailure, logLine, useLogFile } from "../core/logger";
import { abbreviateTitle, isAbbreviated } from "../core/abbreviateTitle";
import { cancelItem } from "../views/dialogs";
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

/**
 * どの作品を片づけるかを訊く（作者の依頼、2026-09-23
 * 「古い指摘を片づけるですが、全作品を選択できるようにしてください」）。
 *
 * **先頭に「すべての作品」を置く。** 作品ごとに1つずつ押していくと、
 * 16作品なら16回同じ確認を読むことになる。
 *
 * **作品ごとに古い指摘の件数を添え、多い順に並べる。** 件数の分からない
 * 窓では、どれを選べばよいか判断できない（`resolveWork` の `annotate` と
 * 同じ考え方。実機で発覚、2026-08-14）。数え損ねた作品も並べる——
 * 選べないと、その作品だけ片づける道が無くなる。
 *
 * 戻り値：作品／`"all"`／取りやめ（`undefined`）
 */
export async function chooseFindingsTarget(
  works: readonly WorkEntry[]
): Promise<WorkEntry | "all" | undefined> {
  const days = findingsRetentionDays();
  const counts = await Promise.all(
    works.map(async (work) => {
      if (!(days > 0)) return 0;
      try {
        return await new FindingStore(work).countExpired(days);
      } catch {
        return undefined;
      }
    })
  );
  const total = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);

  const perWork = works
    .map((work, index) => ({ work, count: counts[index] }))
    // 件数の多い作品を上に。数え損ねたもの（undefined）はいちばん下
    .sort((left, right) => (right.count ?? -1) - (left.count ?? -1))
    .map(({ work, count }) => ({
      label: abbreviateTitle(work.title),
      description:
        count === undefined ? "件数を読めませんでした" : `古い指摘 ${count}件`,
      detail: isAbbreviated(work.title) ? work.title : undefined,
      target: work as WorkEntry | "all",
    }));

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(layers) すべての作品",
        description: `古い指摘 計${total}件（${works.length}作品）`,
        target: "all" as WorkEntry | "all",
      },
      ...perWork,
      cancelItem(),
    ],
    {
      title: "古い指摘を片づける作品",
      placeHolder: `${days > 0 ? `${days}日` : "保存日数"}を過ぎた指摘を消します`,
    }
  );
  return picked && "target" in picked ? picked.target : undefined;
}

/**
 * すべての作品の古い指摘を、**1回の確認で**まとめて片づける
 * （作者の依頼、2026-09-23）。
 *
 * ## 確認は1回、内訳は全部見せる
 *
 * 作品ごとに確認を出すと、作品の数だけ同じ窓を押すことになる。だが
 * **1回にまとめるなら、何がどれだけ消えるかを1枚で見せる**——合計だけだと、
 * どの作品の指摘が消えるのか分からないまま「消す」を押すことになる。
 * ここは作者のデータを消す唯一の道である（実装ルール2）。
 *
 * ## 1作品の失敗で全体を止めない
 *
 * 置き場を読めない作品があっても、ほかの作品は片づける。失敗した作品は
 * 最後にまとめて名前を出す（実装スタイル「チャンク単位の失敗で全体を
 * 止めない。失敗を記録して続行し、最後にまとめて報告する」）。
 */
export async function pruneFindingsAcrossWorks(
  works: readonly WorkEntry[]
): Promise<void> {
  const days = findingsRetentionDays();
  if (!(days > 0)) {
    void vscode.window.showInformationMessage(
      "保存日数が無期限（0）になっているため、古い指摘はありません。" +
        "設定の novelai.findings.retentionDays で日数を決めてください。"
    );
    return;
  }

  const unreadable: WorkEntry[] = [];
  const targets: { work: WorkEntry; count: number }[] = [];
  for (const work of works) {
    try {
      const count = await new FindingStore(work).countExpired(days);
      if (count > 0) targets.push({ work, count });
    } catch (error) {
      noteFailure(work, error);
      unreadable.push(work);
    }
  }

  const total = targets.reduce((sum, target) => sum + target.count, 0);
  if (total === 0) {
    void vscode.window.showInformationMessage(
      `どの作品にも、${days}日を過ぎた指摘はありません。` +
        failureNote("件数を読めなかった作品", unreadable)
    );
    return;
  }

  const breakdown = targets
    .map(({ work, count }) => `・${abbreviateTitle(work.title)}　${count}件`)
    .join("\n");
  const answer = await vscode.window.showWarningMessage(
    `古い指摘 計${total}件を消します（${targets.length}作品）。` +
      `${days}日より前に見つかったもので、いまは一覧に並んでいません。` +
      "消すと元に戻せません。",
    { modal: true, detail: breakdown },
    "消す"
  );
  if (answer !== "消す") return;

  let removed = 0;
  const failed: WorkEntry[] = [];
  for (const { work } of targets) {
    try {
      const count = await new FindingStore(work).prune(days);
      removed += count;
      useLogFile(work.folderPath);
      logLine(`古い指摘を片づけました（${count}件、${days}日より前。すべての作品から）。`);
    } catch (error) {
      noteFailure(work, error);
      failed.push(work);
    }
  }

  const message =
    `古い指摘 計${removed}件を片づけました（${targets.length - failed.length}作品）。` +
    failureNote("片づけられなかった作品", failed) +
    failureNote("件数を読めなかった作品", unreadable);
  if (failed.length > 0) {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
}

/** 失敗した作品の名前を1文にする。無ければ空（知らせを長くしない） */
function failureNote(label: string, works: readonly WorkEntry[]): string {
  if (works.length === 0) return "";
  return `${label}：${works.map((work) => abbreviateTitle(work.title)).join("、")}（理由は各作品のログ）。`;
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
