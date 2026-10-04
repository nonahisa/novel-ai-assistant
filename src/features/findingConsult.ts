import type * as vscode from "vscode";
import * as path from "../core/paths";
import { isMemoLine } from "../core/sceneMemo";
import type { PlacedFinding } from "../core/sceneMemoRows";
import type { WorkEntry } from "../models/types";
import { buildFindingAdviceQuestion } from "../prompts/workChat";

/**
 * 校正・メモパネルの［AIに相談］の材料集めと、「相談パネルで続ける」（設計書6.96.5）。
 *
 * ［AIに相談］そのものは、0.98.14 からパネルの中の短い助言（P-47、
 * `findingAdvice.ts`）になった。相談パネルへ渡すのは、助言の下の
 * 「相談パネルで続ける」を押したときだけである。
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
export interface FindingMaterialDeps {
  /** 本文の文書を読む（**表示しない**。原稿エディターで開いていればその文書） */
  openDocument(filePath: string): Promise<vscode.TextDocument>;
  /** 「第1話 題」のような話の見出し。引けなければ undefined（ファイル名で示す） */
  episodeLabelOf(work: WorkEntry, filePath: string): Promise<string | undefined>;
}

export interface FindingConsultDeps extends FindingMaterialDeps {
  /** 相談パネルへ作者の問いとして送る（`WorkChatPanel.askFromOutside`） */
  askFromOutside(
    question: string,
    target: { document: vscode.TextDocument; range: vscode.Range }
  ): Promise<boolean>;
}

/**
 * 1つの指摘について、相談に渡す材料。
 *
 * **パネルの中の短い助言（P-47）と、相談パネルで続ける道（P-21）の両方が
 * これを使う。** 材料の集め方を2か所に書くと、片方だけ前後の段落の
 * 取り方が変わる日が来る。
 */
export interface FindingMaterial {
  document: vscode.TextDocument;
  range: vscode.Range;
  /** 「第3話の12行目」のような場所 */
  place: string;
  /** 指摘された本文の一文 */
  quote: string;
  /** 指摘の中身 */
  finding: string;
  before?: string;
  after?: string;
}

/** 前後の段落を探しに行く行数の上限（メモや空行が続いても遠くまで読まない） */
const NEIGHBOR_SEARCH_LINES = 5;

export async function collectFindingMaterial(
  work: WorkEntry,
  finding: PlacedFinding,
  deps: FindingMaterialDeps
): Promise<FindingMaterial> {
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

  return {
    document,
    range: line.range,
    place: `${where}の${finding.line}行目`,
    // 置き場の原文が空の古い記録でも、その行の本文で頼める
    quote: finding.original.trim() ? finding.original : line.text,
    finding: finding.message,
    before: neighborParagraph(document, lineIndex, -1),
    after: neighborParagraph(document, lineIndex, 1),
  };
}

/**
 * 相談パネルで続ける（校正・メモパネルの助言の下の小さな口。設計書6.96.5）。
 *
 * パネルの中の短い助言で足りないときだけ、作者が押して相談パネルへ渡す。
 */
export async function consultFindingInChat(
  work: WorkEntry,
  finding: PlacedFinding,
  deps: FindingConsultDeps
): Promise<boolean> {
  const material = await collectFindingMaterial(work, finding, deps);
  const question = buildFindingAdviceQuestion({
    place: material.place,
    quote: material.quote,
    finding: material.finding,
    before: material.before,
    after: material.after,
  });
  return await deps.askFromOutside(question, {
    document: material.document,
    range: material.range,
  });
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
