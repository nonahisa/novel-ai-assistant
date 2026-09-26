/**
 * 矛盾検知（P-12）の組み立てのうち、**製品と外から呼ぶ口の両方が通るもの**
 * （2026-09-26、作者の裁定「MCP の矛盾検知を製品と同じ道に揃える」）。
 *
 * 製品（`features/checkContradictions.ts`）は、過去の関連場面の抜粋（設計書6.74）を
 * 渡し、見つけた指摘を1件ずつ問い直す検証の段（P-12b、6.10.5）を通していた。
 * MCP の道具（`mcp/tools/contradiction.ts`）はどちらも通っておらず、
 * **外から測った数字が製品の数字ではなかった**（CLAUDE.md の「繰り返し起きた
 * 失敗」5番）。逸脱検知の 0.89.25（`plotForDeviation.ts`）と同じ形で、
 * 組み立てをここへ寄せて両方から使う。**写しを2つ持つと、片方だけ直ってずれる。**
 *
 * **`vscode` を持ち込まない**（外から呼ぶ束の起点でもある。
 * `test/unit/cross/mcpReach.test.ts` が見張る）。
 */

import type { Chunk } from "./chunker";
import type { ExcerptSource } from "./mentionExcerpts";
import {
  anyPastSceneReachable,
  buildPastScenes,
  PastSceneIndex,
  type PastSceneSelectionDetail,
  type PastSceneSemantic,
} from "./pastSceneSelect";
import { linesAround } from "./factContradiction";
import { lookupKnownAtValue, type AcceptedContradiction } from "./contradictionValidation";
import { buildContradictionVerifyPrompt } from "../prompts/contradictionVerify";

/**
 * 過去の場面の索引を作る（設計書6.74）。渡りようがなければ undefined。
 *
 * **1件も渡りようがない作品では、索引を組まない**（0.32.6のレビュー）。
 * 合本（1ファイルに全話）はチャンクの話数がファイル単位に決まるため、
 * どのチャンクにも「自分より前の話の場面」が存在しない。索引作り
 * （BM25）はそこそこ重く、確認ダイアログの一文も嘘になる。
 *
 * **失敗は呼ぶ側で受ける。** 過去の場面は補助の材料なので、組めなくても
 * 検知は続ける——製品はログへ、MCP は材料なしで組む。
 */
export function buildContradictionPastSceneIndex(
  sources: readonly ExcerptSource[],
  /** チャンクの話数。**渡りうるかの判断に要る**（`anyPastSceneReachable`） */
  chunkChapters: readonly (number | null)[],
  /** 意味の近さも測るときだけ渡す（設計書6.19.10）。無ければ名前だけ */
  semantic?: PastSceneSemantic
): PastSceneIndex | undefined {
  const scenes = buildPastScenes(sources);
  if (scenes.length === 0) return undefined;
  if (!anyPastSceneReachable(scenes, chunkChapters)) return undefined;
  return new PastSceneIndex(scenes, semantic);
}

/**
 * そのチャンクへ渡す、過去の関連場面（設計書6.74）。
 *
 * **名前が1つも出ないチャンクでは、名前では引かない。** 検索語が無いまま
 * 引くと無関係な場面が並び、従来より悪くなる（＝そのときは従来と同じ入力）。
 * 意味の近さで引くのは索引を渡したときだけで、下限より遠い場面は入れない。
 */
export function selectContradictionPastScenes(
  index: PastSceneIndex | undefined,
  chunk: Chunk,
  /** この本文に出た索引の語（`ContradictionMaterial.namesIn`）。前の話の名前ではない */
  terms: readonly string[],
  maxChars: number
): PastSceneSelectionDetail {
  if (!index) return { text: "", byName: 0, byMeaning: 0 };
  return index.selectWithDetail({
    // **まとめたチャンクは、いちばん前の話に合わせる**（設計書6.10.3）
    chapter: chunk.chapterStart,
    terms,
    maxChars,
    // 索引を渡していなければ見られない（意味の近さを測るときだけ使う）
    chunkText: chunk.text,
  });
}

/** 検証の段で、指摘の行の前後を何行ずつ見せるか */
export const CONTRADICTION_VERIFY_CONTEXT_LINES = 6;

/**
 * 該当行の前後を、行番号付きで切り出す。
 *
 * **切り出しそのものは `core/factContradiction.ts` に置いてある。**
 * 事実の照合（6.88の第4段）はチャンクではなくファイルから同じものを
 * 切り出すので、番号の振り方が2か所で食い違うと、片方だけ1行ずれる。
 */
export function contradictionVerifyContext(chunk: Chunk, line: number): string {
  return linesAround(
    chunk.text,
    line,
    CONTRADICTION_VERIFY_CONTEXT_LINES,
    chunk.startLine + 1
  );
}

/**
 * その値が何話で分かるか（設計書6.10.5）を、検証のプロンプトへ書く形にする。
 * 分からなければ空文字（プロンプトは「（不明）」と書く）。
 *
 * 指摘には「どの項目の話か」が付いてこないので、値だけで引く。
 */
export function describeKnownAt(
  knownAt: ReadonlyMap<string, number[]>,
  value: string
): string {
  const chapters = lookupKnownAtValue(knownAt, value);
  if (chapters.length === 0) return "";
  return chapters.map((at) => `第${at}話`).join("、");
}

/** 検証で分かったことを、もとの補足へ足す（作者の判断材料になる） */
export function appendVerifyNote(note: string, explanation: string): string {
  const extra = explanation.trim();
  if (!extra) return note;
  return note.trim() ? `${note.trim()}（検証: ${extra}）` : `検証: ${extra}`;
}

/** 1件だけを見て、本当に矛盾かを問い直すプロンプト（P-12b、設計書6.10.5） */
export function buildContradictionVerifyUserPrompt(input: {
  chapterLabel: string;
  chunk: Chunk;
  issue: AcceptedContradiction;
  /** `describeKnownAt` の結果 */
  settingKnownAt: string;
}): string {
  return buildContradictionVerifyPrompt({
    chapterLabel: input.chapterLabel,
    contextWithLineNumbers: contradictionVerifyContext(input.chunk, input.issue.line),
    excerpt: input.issue.excerpt,
    settingSays: input.issue.settingSays,
    textSays: input.issue.textSays,
    category: input.issue.category,
    settingKnownAt: input.settingKnownAt,
  });
}
