import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { atomicWriteFile } from "./atomicWrite";
import { parseRetractionOffers, type RetractionOffer } from "./characterSeparate";

/**
 * 「分けた記録の取り下げ」を一度持ちかけた記録の覚書（作者の裁定、
 * 2026-10-03。設計書6.5.8）。
 *
 * `.aiwriter/separation-retraction-offered.json`。作品ごとに持つ。
 * `narratorNoticeStore.ts` と同じく拡張機能だけが書くので、そのまま置き換えて
 * よい（`atomicWriteFile` を引数無しで呼ぶ）。
 *
 * **人物のJSONに欄を足さない。** 人物の形は外のツール向けのスキーマ
 * （`settingsSchema.ts`、項目の追加を許さない）とテストで突き合わせており、
 * 「一度訊いた」は作者の資料ではなく、この拡張機能の都合だからである。
 */

const FILE_NAME = "separation-retraction-offered.json";

function filePath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, FILE_NAME);
}

/** 覚えている記録。無い・壊れているときは空（もう一度持ちかけるだけ） */
export async function readRetractionOffers(
  work: WorkEntry
): Promise<RetractionOffer[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath(work)));
    return parseRetractionOffers(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return [];
  }
}

/**
 * 持ちかけた記録を足して覚える。**失敗しても何も止めない**
 * ——覚えそこねても、次の抽出のあとにもう一度訊くだけである。
 */
export async function rememberRetractionOffers(
  work: WorkEntry,
  known: readonly RetractionOffer[],
  added: readonly RetractionOffer[]
): Promise<void> {
  if (added.length === 0) return;
  const offered = [...known];
  for (const entry of added) {
    if (!offered.some((item) => item.id === entry.id && item.name === entry.name)) {
      offered.push({ id: entry.id, name: entry.name });
    }
  }
  try {
    await vscode.workspace.fs.createDirectory(
      path.toUri(workPaths(work).aiwriter)
    );
    await atomicWriteFile(
      filePath(work),
      new TextEncoder().encode(`${JSON.stringify({ offered }, null, 2)}\n`)
    );
  } catch {
    // 覚えそこねは黙ってよい（上のとおり、次回また訊くだけ）
  }
}
