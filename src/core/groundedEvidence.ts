import { segmentsOf, type Chunk } from "./chunker";

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

/**
 * 本文を検索するための語を evidence から作る。
 *
 * 世界観の見出し（「詠唱の制約」）は**本文に出てこない言葉**なので、
 * 名前で本文を引くと場面が1つも集まらず、AIへの相談も項目の充実も
 * 材料なしで動くことになる。逐語引用である evidence を手掛かりにする。
 *
 * 照合用の `evidenceSegments` と違い、**空白を落とさない**。
 * こちらは本文そのものを検索するので、表記を変えると一致しなくなる。
 */
export function evidencePhrases(
  evidence: string | null | undefined,
  minLength = 6,
  limit = 3
): string[] {
  if (!evidence) return [];
  return evidence
    .replace(/<0x[0-9A-Fa-f]{2}>/gu, "")
    .split(/[\r\n。！？!?、,]+/u)
    .map((segment) =>
      segment.replace(/^[「『"'“”‘’（(\s…]+|[」』"'“”‘’）)\s…]+$/gu, "")
    )
    .filter((segment) => segment.length >= minLength)
    // 長い断片ほど誤一致しにくい
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);
}

/**
 * その候補が「どの話に出てきたか」を、本文と照合して決める。
 *
 * 小さいファイルをまとめて1回で送ると、チャンクは複数の話にまたがる。
 * チャンク全体の話数をそのまま付けると、**第3話にしか出ない人物が
 * 「第1〜4話に登場」になる。** 設定資料の登場話数も、呼称の使用期間も狂う。
 *
 * そこで、逐語引用（evidence）がチャンクのどの位置にあるかを調べ、
 * その位置の話数だけを付ける。**AIに話数を言わせない。**
 * 本文から機械的に求まる値をAIに書かせると、次の抽出で戻されて食い違う。
 *
 * 引用で決まらなければ呼称の位置で決め、それでも分からなければ
 * チャンク全体の話数を返す（今までどおり。取りこぼすよりは広く付ける）。
 */
export function chaptersForCandidate(
  chunk: Chunk,
  appellations: Array<string | null | undefined>,
  evidence: string | null | undefined
): number[] {
  const whole = chaptersForChunk(chunk);
  if (segmentsOf(chunk).length <= 1) return whole;

  const byEvidence = segmentsContaining(chunk, (text) =>
    evidenceSegments(evidence).some((fragment) => text.includes(fragment))
  );
  if (byEvidence.length > 0) return byEvidence;

  const names = appellations
    .map((name) => normalizeForComparison(name ?? ""))
    .filter((name) => name.length > 0);
  const byName = segmentsContaining(chunk, (text) =>
    names.some((name) => text.includes(name))
  );
  if (byName.length > 0) return byName;

  return whole;
}

/** 条件に当てはまる話の話数を集める（照合用に正規化した本文を渡す） */
function segmentsContaining(
  chunk: Chunk,
  matches: (normalizedText: string) => boolean
): number[] {
  const found = new Set<number>();
  for (const segment of segmentsOf(chunk)) {
    const text = normalizeForComparison(
      chunk.text.slice(segment.start, segment.end)
    );
    if (!matches(text)) continue;
    for (const chapter of chaptersForRange(
      segment.chapterStart,
      segment.chapterEnd
    )) {
      found.add(chapter);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** チャンクが対応する話数を列挙する */
export function chaptersForChunk(chunk: Chunk): number[] {
  return chaptersForRange(chunk.chapterStart, chunk.chapterEnd);
}

function chaptersForRange(
  start: number | null,
  end: number | null
): number[] {
  if (!Number.isSafeInteger(start) || start === null || start < 0) return [];
  const last = end ?? start;
  if (!Number.isSafeInteger(last) || last < start) return [];

  const chapters: number[] = [];
  for (let chapter = start; chapter <= last; chapter++) {
    chapters.push(chapter);
  }
  return chapters;
}
