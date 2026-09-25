import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import { logFailure, useLogFile } from "../core/logger";
import {
  buildVerdictStatsMarkdown,
  parseVerdictLines,
  tallyVerdicts,
  type VerdictCount,
  type VerdictLine,
} from "../core/verdictTally";

/**
 * 作者が採った・退けた指摘の記録（設計書6.49.7）。
 *
 * **`.aiwriter/history/ai-verdicts.jsonl`。1行1件、追記のみ、同期する。**
 *
 * ## 作品フォルダーに置く理由（保管庫ではなく）
 *
 * 1. **作者の判断の記録だから。** 編集履歴（`history/edits.jsonl`）・
 *    指摘の置き場（`findings.jsonl`）と同じく、作品と一緒に持ち歩く。
 *    デスクトップで採った指摘と、ノートPCで退けた指摘を合わせて数えられる
 * 2. **モデルの当たりは機械に依らない。** 同じ名前のモデルなら、どの機械で
 *    動かしても出す指摘は同じである。機械ごとに分けるべきなのは、VRAM で
 *    変わる読める長さや回線で変わる待ち時間（AIチューニングの台帳）であって、
 *    ここではない
 * 3. **追記のみなので、同期の衝突が起きにくい**（同じ行を両方が書き換えない）
 *
 * **`history/` は同期する側**である（除外は `cache/`・`logs/` ほか。
 * `workRegistry.ts` の `IGNORED_PATHS`）。`logs/ai_actions.log` にも採否は
 * 残るが、あちらは同期しないうえ、モデルの名前を持たない。
 *
 * **片づけない。** 1件1行で小さく、消すと率が振り出しへ戻る
 * （`findings.jsonl` は「古い指摘を片づける」で判断ごと消える——
 * 数える記録をそこへ置かなかった理由）。
 */

const VERDICT_DIRECTORY = "history";
const VERDICT_FILE = "ai-verdicts.jsonl";

function verdictFilePath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, VERDICT_DIRECTORY, VERDICT_FILE);
}

/**
 * 判断を1件足す。
 *
 * **失敗しても呼び出し側を止めない。** 数えられないのは惜しいが、そのために
 * 作者の操作（適用・見送り）を失敗させるのは本末転倒である。理由はログへ残す
 * （握りつぶさない）。
 */
export async function appendVerdict(
  work: WorkEntry,
  line: VerdictLine
): Promise<void> {
  try {
    const target = verdictFilePath(work);
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    const uri = path.toUri(target);
    let existing: Uint8Array;
    try {
      existing = await vscode.workspace.fs.readFile(uri);
    } catch {
      existing = new Uint8Array();
    }
    const added = new TextEncoder().encode(`${JSON.stringify(line)}\n`);
    const merged = new Uint8Array(existing.byteLength + added.byteLength);
    merged.set(existing, 0);
    merged.set(added, existing.byteLength);
    await vscode.workspace.fs.writeFile(uri, merged);
  } catch (error) {
    try {
      useLogFile(work.folderPath);
      logFailure("指摘の採否の記録に失敗", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // 記録にも残せないなら、できることはもう無い
    }
  }
}

/**
 * 書庫のすべての作品の記録を読んで数える。
 *
 * **読めない作品は飛ばす**（まだ一度も判断していない作品には記録が無い）。
 * 1つの作品が読めないせいで、ほかの作品の数まで見えなくしない。
 */
export async function loadVerdictCounts(
  works: readonly WorkEntry[]
): Promise<VerdictCount[]> {
  const groups: VerdictLine[][] = [];
  for (const work of works) {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(verdictFilePath(work))
      );
      groups.push(parseVerdictLines(new TextDecoder().decode(bytes)));
    } catch {
      // 無い・読めない。**騒がずに見送る**
    }
  }
  return tallyVerdicts(groups);
}

/**
 * AIチューニングの記録（`novelai.showTuningStats`）に足す節。
 *
 * 表示名はプロバイダ自身と機能別割当の表から引く（写しを作らない）。
 */
export async function verdictStatsSection(
  works: readonly WorkEntry[],
  providerLabel: (providerId: string) => string,
  featureLabel: (feature: VerdictCount["feature"]) => string
): Promise<string> {
  return buildVerdictStatsMarkdown(
    await loadVerdictCounts(works),
    providerLabel,
    featureLabel
  );
}
