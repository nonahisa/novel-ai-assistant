/**
 * AIが**1回の応答でどれだけ書けるか**を測る（設計書6.61）。
 *
 * 読める長さ（`contextProbe.ts`）と対になる仕組みである。あちらは
 * 「送った本文が届いたか」を測り、こちらは「返せる量」を測る。
 *
 * ## なぜ要るのか
 *
 * チャンクの天井（`MAX_CHUNK_CHARS = 20,000`）は**当て推量だった**。
 * 抽出の応答は入力に比例して育ち、出力上限を超えると途中で切れて
 * **そのチャンクは丸ごと捨てられる**。20,000という数字は「応答が収まる
 * 入力量」の代わりに置いた値で、根拠が無い（作者の指摘、2026-09-01）。
 *
 * **手元のAIには、出力上限を訊く口が無い。** Gemini は API が
 * `outputTokenLimit` を返し、Claude も同様に取れるが、Ollama の
 * `/api/show` にも LM Studio にもその項目は無い。**訊けないなら測るしかない。**
 *
 * ## 測り方
 *
 * **数えられる出力をさせる。** 「`0001` から順に4桁の数字を N 行」と頼み、
 * 返ってきた行を数える。あらすじや設定を書かせると、**AIが勝手に切り上げた
 * のか上限で切られたのかを区別できない**——番号なら、どこで止まったかが
 * そのまま答えになる。
 *
 * **トークン数は見積もらない。** 応答には実際の出力トークン数が付いてくる
 * （Ollama の `eval_count`、OpenAI互換の `completion_tokens`）ので、
 * それをそのまま使う。数字の並びは日本語と刻まれ方が違うため、
 * 字数からの換算（`TOKENS_PER_CHAR`）はここでは当てにならない。
 */

/** 1行の桁数。4桁なら9,999行まで番号が重ならない */
const DIGITS = 4;

/** 最初に頼む行数。ここが通れば設定の上限まで跳ぶ（6.59と同じ考え方） */
export const START_OUTPUT_LINES = 100;

/**
 * これ以上は頼まない行数。
 *
 * 9,999行を超えると4桁で足りなくなる。実用上も、1行が約3トークンなので
 * 9,999行はおよそ30,000トークン——手元のモデルでここまで書けるものは
 * 当面出てこない。
 */
export const MAX_OUTPUT_LINES = 9999;

/** 探索を打ち切る幅。読める長さの測定（`PROBE_CONVERGENCE_RATIO`）と揃える */
export const OUTPUT_CONVERGENCE_RATIO = 0.1;

export interface OutputProbeState {
  /** 頼める行数の上限 */
  ceilingLines: number;
  /** 最後まで書けた最大の行数 */
  low: number;
  /** 書き切れなかった最小の行数。まだ無ければ undefined */
  high: number | undefined;
  /** いま頼む行数 */
  current: number;
}

/**
 * 指示。**前置きを書かせない**——「はい、承知しました」で始められると、
 * 数えた行数がその分ずれる。
 */
export const OUTPUT_PROBE_SYSTEM_PROMPT =
  "あなたは指示どおりに出力する装置です。前置きも説明も書かず、" +
  "求められたものだけを出力します。";

export function buildOutputProbePrompt(lines: number): string {
  return (
    `1行に1つ、${DIGITS}桁の数字を 0001 から順に ${lines} 行書いてください。\n` +
    "- 0001、0002、0003 … のように1ずつ増やします\n" +
    "- 1行に数字だけを書き、ほかの文字は書きません\n" +
    "- 途中を省略したり「（中略）」と書いたりしないでください\n" +
    `- ${lines} 行ちょうどで終えてください`
  );
}

/**
 * 返事の中で、**先頭から続いている正しい番号の数**を数える。
 *
 * **途中から数え直さない。** 「0001〜0100 まで書いて、飛んで 0500」の
 * ような返事を「500行書けた」と読むと、上限を実際より大きく見積もる。
 * 続いているところまでが、確かに書けた量である。
 */
export function countOutputLines(text: string): number {
  let expected = 1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 番号以外の行（前置き・囲みの記号）はそこで打ち切る。
    // **読み飛ばさない**——飛ばすと、説明文を挟んだ返事を過大に数える
    if (line !== String(expected).padStart(DIGITS, "0")) break;
    expected += 1;
  }
  return expected - 1;
}

export function startOutputProbeState(ceilingLines: number): OutputProbeState {
  const ceiling = Math.max(1, Math.min(ceilingLines, MAX_OUTPUT_LINES));
  return {
    ceilingLines: ceiling,
    low: 0,
    high: undefined,
    current: Math.min(START_OUTPUT_LINES, ceiling),
  };
}

/**
 * 次に頼む行数。終わりなら undefined。
 *
 * **1回当ててから上限へ跳ぶ**（6.59と同じ）。倍々に伸ばすと、書ける
 * モデルほど無駄な回が増える——しかも出力は生成なので、1回が読むより
 * ずっと遅い。**待ち時間がそのまま作者の損になる。**
 *
 * 1回目を小さくする理由も同じで、**一度も書けていないうちの失敗は
 * 「長すぎた」のか「そもそも繋がっていない」のか見分けられない**。
 */
export function nextOutputProbeSize(
  state: OutputProbeState,
  completed: boolean
): OutputProbeState | undefined {
  const low = completed ? Math.max(state.low, state.current) : state.low;
  const high = completed
    ? state.high
    : state.high === undefined
      ? state.current
      : Math.min(state.high, state.current);

  if (high === undefined) {
    const next = state.ceilingLines;
    if (next <= low) return undefined;
    return { ceilingLines: state.ceilingLines, low, high, current: next };
  }

  if (high - low <= Math.max(1, low * OUTPUT_CONVERGENCE_RATIO)) {
    return undefined;
  }

  const mid = Math.floor((low + high) / 2);
  if (mid <= low || mid >= high) return undefined;

  return { ceilingLines: state.ceilingLines, low, high, current: mid };
}

/**
 * 結果を作者へ伝える言葉。
 *
 * **トークン数を主にする。** 設定（`novelai.maxOutputTokens`）も
 * チャンクの見積もりもトークンで動いているので、行数のままでは使えない。
 */
export function describeOutputProbeResult(input: {
  /** 最後まで書けた最大の行数 */
  lines: number;
  /** そのときAIが実際に使った出力トークン数（応答に付いてくる実数） */
  tokens: number | undefined;
  /** 頼める上限まで届いたか */
  reachedCeiling: boolean;
}): string {
  if (input.lines <= 0) {
    return (
      `いちばん短い ${START_OUTPUT_LINES} 行すら最後まで書けませんでした。` +
      "出力の長さではなく、AIの設定か接続の側に原因がありそうです。"
    );
  }
  const parts = [
    input.tokens !== undefined
      ? `1回の応答で書けたのは 約 ${input.tokens.toLocaleString("ja-JP")} ` +
        `トークン（${input.lines.toLocaleString("ja-JP")} 行）です。`
      : `1回の応答で ${input.lines.toLocaleString("ja-JP")} 行まで書けました。`,
  ];
  if (input.reachedCeiling) {
    // **言い切らない**（読める長さの測定と同じ作法）
    parts.push("測れる上限まで書き切ったので、これより長く書ける可能性があります。");
  }
  return parts.join("");
}
