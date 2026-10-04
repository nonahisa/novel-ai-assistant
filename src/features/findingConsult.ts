import type * as vscode from "vscode";
import * as path from "../core/paths";
import { isMemoLine } from "../core/sceneMemo";
import type { PlacedFinding } from "../core/sceneMemoRows";
import type { WorkEntry } from "../models/types";
import { buildFindingAdviceQuestion } from "../prompts/workChat";

/**
 * 校正・メモパネルの［AIに相談］（設計書6.96.5）。
 *
 * **素のエディターを開かない**（作者の報告 2026-10-04。開発ホスト 0.98.9）。
 * 以前は「AI相談（選択範囲）」と同じく、本文をその行を選んだ状態で
 * `showTextDocument`（横の列）に開いてから相談パネルへ渡していた。
 * 押すと右に素のエディターで第1話が開き、画面が3列になった——原稿は
 * 原稿エディターでしか開かない決まり（6.25.10・6.25.11）に反する。
 *
 * いまは、相談に要る材料（話の題・行番号・一文と前後の段落・指摘の中身）を
 * 依頼文に入れ、相談の相手（文書とその行）を相談パネルへ直接渡す。
 * 文書は `openTextDocument` で読むだけで、タブは作らない。
 */
export interface FindingConsultDeps {
  /** 本文の文書を読む（**表示しない**。原稿エディターで開いていればその文書） */
  openDocument(filePath: string): Promise<vscode.TextDocument>;
  /** 「第1話 題」のような話の見出し。引けなければ undefined（ファイル名で示す） */
  episodeLabelOf(work: WorkEntry, filePath: string): Promise<string | undefined>;
  /** 相談パネルへ作者の問いとして送る（`WorkChatPanel.askFromOutside`） */
  askFromOutside(
    question: string,
    target: { document: vscode.TextDocument; range: vscode.Range }
  ): Promise<boolean>;
}

/** 前後の段落を探しに行く行数の上限（メモや空行が続いても遠くまで読まない） */
const NEIGHBOR_SEARCH_LINES = 5;

export async function consultFindingInChat(
  work: WorkEntry,
  finding: PlacedFinding,
  deps: FindingConsultDeps
): Promise<boolean> {
  const document = await deps.openDocument(finding.filePath);
  const lineIndex = Math.min(
    Math.max(finding.line - 1, 0),
    Math.max(document.lineCount - 1, 0)
  );
  const line = document.lineAt(lineIndex);

  const label = await deps.episodeLabelOf(work, finding.filePath).catch(
    () => undefined
  );
  // 話の題が引けないとき（走査できない・話でないファイル）はファイル名で示す。
  // ブラウザ版では場所が符号の形で来るので、解いてから名前にする
  const where =
    label ?? path.basename(path.decodeUriEscapes(finding.filePath));

  const question = buildFindingAdviceQuestion({
    place: `${where}の${finding.line}行目`,
    // 置き場の原文が空の古い記録でも、その行の本文で頼める
    quote: finding.original.trim() ? finding.original : line.text,
    finding: finding.message,
    before: neighborParagraph(document, lineIndex, -1),
    after: neighborParagraph(document, lineIndex, 1),
  });
  return await deps.askFromOutside(question, { document, range: line.range });
}

/**
 * 指摘の行の前（`step = -1`）・後ろ（`step = 1`）にある本文の段落。
 *
 * 空の行とメモの行（`// TODO …`）は飛ばす——メモは作者の覚え書きで、
 * 本文の流れではない。近くに無ければ省く
 */
function neighborParagraph(
  document: vscode.TextDocument,
  lineIndex: number,
  step: -1 | 1
): string | undefined {
  for (let offset = 1; offset <= NEIGHBOR_SEARCH_LINES; offset++) {
    const index = lineIndex + step * offset;
    if (index < 0 || index >= document.lineCount) return undefined;
    const text = document.lineAt(index).text;
    if (!text.trim() || isMemoLine(text)) continue;
    return text;
  }
  return undefined;
}
