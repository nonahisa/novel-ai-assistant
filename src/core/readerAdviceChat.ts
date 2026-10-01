import type { PostingLedger } from "../models/posting";
import { buildReaderAdviceMaterials } from "./readerAdvice";
import {
  buildReaderReactionChatBlock,
  questionMentionsReaderReaction,
} from "../prompts/readerAdvice";

/**
 * 相談へ足す「読者の反応の材料」（設計書6.79.7.3）。
 *
 * **質問が読者の反応の話のときだけ**台帳を読む。ほかの質問で台帳を開くと、
 * 相談のたびにディスクを触るうえ、数字が答えを引っ張る。
 *
 * 台帳の読み込みは呼ぶ側から渡してもらう（ここは `vscode` に依らない——
 * 相談パネルの外、試験からも同じ判断を確かめられるように）。読めなかった
 * ときの扱い（相談は止めない）も呼ぶ側が決める。
 *
 * @returns 足す文と、材料を作れたサイトの名前。読者の反応の話でなければ undefined
 */
export async function readerReactionChatBlockFor(
  question: string,
  loadLedger: () => Promise<PostingLedger>
): Promise<{ text: string; sites: string[] } | undefined> {
  if (!questionMentionsReaderReaction(question)) return undefined;
  const ledger = await loadLedger();
  return readerReactionChatBlockFromLedger(question, () => ledger);
}

/**
 * 上と同じ判断を、台帳を**同期で**読める呼び手のために（2026-10-01。残課題 R6）。
 *
 * 外から呼ぶ相談（`mcp/tools/chat.ts`）は Node の `fs` で台帳を同期で読み、
 * プロンプトの組み立ても同期である。**判断（読者の反応の話か・材料の組み方）は
 * この1か所**にあり、上の非同期版もここを通る——写しを作らないため。
 */
export function readerReactionChatBlockFromLedger(
  question: string,
  loadLedger: () => PostingLedger
): { text: string; sites: string[] } | undefined {
  if (!questionMentionsReaderReaction(question)) return undefined;
  const materials = buildReaderAdviceMaterials(loadLedger());
  return {
    text: buildReaderReactionChatBlock(materials),
    sites: materials.map((material) => material.siteLabel),
  };
}
