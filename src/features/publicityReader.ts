// ログの書き先：呼ぶ側が向ける（紹介文・キャッチコピー・告知文が、作品のログへ向けてから呼ぶ）
import type { WorkEntry } from "../models/types";
import type { ReaderProfile } from "../models/readerProfile";
import { ReaderTargetStore } from "../core/readerTargetStore";
import {
  publicityReaderLabels,
  publicityReaderMark,
  resolvePublicityReader,
  type PublicityReader,
} from "../core/publicityReader";
import { logFailure, logStep } from "../core/logger";
import { readTargetSheetState } from "./targetSheet";

/**
 * 紹介文・キャッチコピー・告知文へ添える「狙いの読者」を、作品から読む
 * （設計書6.6.5・6.41.2。決め方は `core/publicityReader.ts`）。
 *
 * **読むのは、サブタイトルの案（`generateSynopses.ts`）と同じ部品**
 * ——シートは「ターゲット読者」と同じ `readTargetSheetState`（作者が
 * 自分で置いた同名のファイルからは読まない）、読者像は `ReaderTargetStore`。
 *
 * **読めなくても止めない。** 読者は「あれば足す」材料で、読めないときは
 * 今までどおりの紹介文になるだけである。読めなかったことはログに残す
 * （黙って今までどおりにすると、狙いを決めたのに効いていない理由を追えない）。
 *
 * @param action ログに書く機能の名前（「作品紹介文」など）
 */
export async function loadPublicityReader(
  work: WorkEntry,
  action: string
): Promise<PublicityReader | undefined> {
  let authorBlock: string | undefined;
  try {
    const state = await readTargetSheetState(work);
    // 紙が無ければ初期値（狙い無し）が返るので、そのまま渡してよい
    authorBlock = state.authorOwned ? undefined : state.authorBlock;
  } catch (error) {
    logFailure(`${action}: ターゲットシートを読めませんでした`, {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }

  let profile: ReaderProfile | undefined;
  try {
    profile = await new ReaderTargetStore(work).load();
  } catch (error) {
    logFailure(`${action}: 読者像の台帳を読めませんでした`, {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }

  const reader = resolvePublicityReader({ authorBlock, profile });
  // **何に向けて書かせたかを残す**（相談の `readerTypeChatLogLines` と同じ考え）。
  // 出来の当たり外れを見るとき、どの材料を基準にしたかが分かれ目になる
  logStep(
    reader
      ? `${action}: 読者 ${publicityReaderLabels(reader)}（${reader.source}／印 ${publicityReaderMark(reader)}）`
      : `${action}: 読者 なし（狙いも読者像も無いので添えない）`
  );
  return reader;
}
