import type { WorkEntry } from "../models/types";
import type { Finding } from "../models/finding";
import { readTextFile } from "../core/textFile";
import { logFailure, useLogFile } from "../core/logger";
import {
  buildFinding,
  findingIdOf,
  type FindingDraft,
} from "../core/findingSource";
import { FindingStore } from "./findingStore";

/**
 * 検知が出した指摘を、`.aiwriter/findings.jsonl` へ残す（設計書6.96）。
 *
 * ## ここは下書き置き場であって、台帳ではない
 *
 * 残すのは**指摘そのもの**と**作者の判断**だけである。設定資料・人物・
 * 伏線・章立てへは1バイトも書かないし、本文も1文字も書き換えない
 * （6.96.2・6.96.6）。
 *
 * ## 失敗しても、検知を止めない
 *
 * 残すのは「あとで見返せると助かる」ための下書きであって、検知そのものの
 * 目的ではない。書けなかったからといって**作者がいま見ている指摘を
 * 消してはいけない**ので、ここで受け止めて記録へ落とす。
 *
 * ## 本文を読むのがここに在る理由
 *
 * 前後の文脈（`before` / `after`）は本文からしか取れない。`core` から
 * `vscode` を触らない決めなので、読むところだけを `features` 側に置き、
 * 1件を組むところは `core/findingSource.ts` に置いてある。
 */

/**
 * 今回の検知で出た指摘を残す。
 *
 * **同じ番号が既にあっても足す**（`FindingStore.record` が追記のみ）。
 * 読むときに1件へ畳まれるので、書く側は前の行を探さなくてよい。
 *
 * **本文は1ファイルにつき1回だけ読む。** 19話ぶんの誤字脱字は数百件
 * 出ることがあり、1件ごとに読むと同じファイルを何十回も読むことになる。
 */
export async function recordFindings(
  work: WorkEntry,
  drafts: readonly FindingDraft[]
): Promise<void> {
  if (drafts.length === 0) return;
  try {
    // **1回の検知で時刻を揃える。** 期限（6.96.4）の起点なので、
    // 同じ実行で出た指摘が数ミリ秒ずれた別の日付を持つ意味がない
    const time = new Date().toISOString();
    const texts = new Map<string, string | undefined>();
    const findings: Finding[] = [];
    for (const draft of drafts) {
      if (!texts.has(draft.filePath)) {
        texts.set(draft.filePath, await readOrUndefined(draft.filePath));
      }
      const text = texts.get(draft.filePath);
      // 読めない本文の指摘は残さない（原文が実在するか確かめられない）
      if (text === undefined) continue;
      const finding = buildFinding(work.folderPath, draft, text, time);
      if (finding) findings.push(finding);
    }
    await new FindingStore(work).record(findings);
  } catch (error) {
    noteFailure(work, "指摘の記録に失敗", error);
  }
}

/**
 * 作者の判断（採った・退けた）を足す。
 *
 * **追記のみで、指摘の行は書き換えない**（6.96.4）。同期の衝突を避ける
 * ためであり、片方の機械で退けたものがもう片方でも退くのは、この形なら
 * 自然に成立する。
 *
 * **適用そのものは既存の道が済ませたあとに呼ぶ。** ここは記録するだけで、
 * 本文にも台帳にも触らない。
 */
export async function recordFindingDecision(
  work: WorkEntry,
  draft: FindingDraft,
  status: "accepted" | "dismissed",
  note = ""
): Promise<void> {
  try {
    await new FindingStore(work).decide([
      {
        findingId: findingIdOf(work.folderPath, draft),
        time: new Date().toISOString(),
        status,
        note,
      },
    ]);
  } catch (error) {
    noteFailure(work, "指摘の判断の記録に失敗", error);
  }
}

async function readOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return (await readTextFile(filePath)).text;
  } catch {
    return undefined;
  }
}

/**
 * 失敗を記録に残す。**通知は出さない。**
 *
 * 作者は検知の結果を見ている最中である。下書きを残せなかったことを
 * ダイアログで割り込んでも、その場でできることが無い。
 *
 * **記録そのものが失敗しても、ここから外へは出さない。** この関数は
 * 「止めないため」に在るので、ここが投げると目的が反転する——呼び出し元は
 * 適用や見送りの終わりで待っており、投げれば作者の操作ごと落ちる。
 */
function noteFailure(work: WorkEntry, label: string, error: unknown): void {
  try {
    useLogFile(work.folderPath);
    logFailure(label, {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // 記録にも残せないなら、できることはもう無い
  }
}
