import type { Chunk } from "./chunker";

/**
 * AIが捏造していないかを本文と照合する共通処理。
 * 人物・能力・場所で同じ判定を使う。
 *
 * 次の2つを別々に確認する。
 *   1. 呼称が本文に実在すること（名前の捏造を防ぐ）
 *   2. evidenceの断片が本文に逐語で存在すること（引用の捏造を防ぐ）
 *
 * かつて「1つの断片が本文に存在し、かつその断片が呼称を含むこと」を
 * 求めていたが、会話文が根拠の場合、話者は自分の名前を台詞で言わないため
 * 構造的に必ず落ちていた（実データで主要人物が11件除外された）。
 * 引用が「その対象についてのものか」はコードでは判定できないため、
 * 捏造でないことの確認までに留める。
 */
export function isGroundedInChunk(
  appellations: Array<string | null | undefined>,
  evidence: string | null | undefined,
  chunkText: string
): boolean {
  const normalizedAppellations = appellations
    .map((appellation) => normalizeForComparison(appellation ?? ""))
    .filter((appellation) => appellation.length > 0);
  if (normalizedAppellations.length === 0) return false;

  const normalizedChunk = normalizeForComparison(chunkText);

  if (
    !normalizedAppellations.some((appellation) =>
      normalizedChunk.includes(appellation)
    )
  ) {
    return false;
  }

  return evidenceSegments(evidence).some((segment) =>
    normalizedChunk.includes(segment)
  );
}

/**
 * 照合用に表記の揺れを落とす。
 *
 * gemma系は全角スペースを `<0xE3><0x80><0x80>` のようなバイト表記のまま
 * 出力することがあり、そのままでは逐語一致に失敗する。
 * 空白の全角・半角差も同じ理由で無視する。
 */
export function normalizeForComparison(text: string): string {
  return text.replace(/<0x[0-9A-Fa-f]{2}>/gu, "").replace(/[\s　]/gu, "");
}

/** 照合に使える長さの断片だけを、正規化した形で返す */
export function evidenceSegments(
  evidence: string | null | undefined
): string[] {
  if (!evidence) return [];
  return evidence
    .split(/[\r\n。！？!?]+/u)
    .map((segment) =>
      segment.replace(/^[「『"'“”‘’（(\s…]+|[」』"'“”‘’）)\s…]+$/gu, "")
    )
    .filter((segment) => segment.length >= 4)
    .map(normalizeForComparison)
    // 空白や記号だけの断片は、正規化後に短くなり誤一致の元になる
    .filter((segment) => segment.length >= 4);
}

/** チャンクが対応する話数を列挙する */
export function chaptersForChunk(chunk: Chunk): number[] {
  const start = chunk.chapterStart;
  if (!Number.isSafeInteger(start) || start === null || start < 0) return [];
  const end = chunk.chapterEnd ?? start;
  if (!Number.isSafeInteger(end) || end < start) return [];

  const chapters: number[] = [];
  for (let chapter = start; chapter <= end; chapter++) {
    chapters.push(chapter);
  }
  return chapters;
}
