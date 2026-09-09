import { AIError, type AIProvider } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { isPlaceholderText } from "../core/placeholderText";
import { findTextRange } from "../core/textLocate";
import {
  buildRecheckPrompt,
  RECHECK_SCHEMA,
  RECHECK_SYSTEM_PROMPT,
} from "../prompts/recheck";

/**
 * 提案パネルの指摘1件を、いまの本文でもう一度確かめる（P-23）。
 *
 * 作者の依頼（2026-08-27）：「なおし方を作者が決める系のものは『再チェック』
 * ボタンを追加してください。なおして解消されたか確認したいです」
 * 「誤字脱字の提案パネルでも、違うそうじゃないという提案がきます。
 * 手書きで書き直して解消したか確認したいです」。
 *
 * ## 安い順に確かめる
 *
 * 1. **引用がまだそのまま在るか**を照合する。在れば本文は変わっていないので、
 *    **AIを呼ばない。** 直し忘れがその場で分かる（無料）
 * 2. 変わっていたら、該当箇所の前後だけを添えてAIに1問だけ聞く
 *
 * 検知をやり直せば同じことは分かるが、あちらは作品まるごとを何十チャンクにも
 * 割って走らせる。**1件のために全部を走らせ直すのは高い。**
 *
 * ## VS Code に依存させない
 *
 * ファイルの読み込みは呼び出し側（`features/proposalPanel.ts`）が行い、
 * ここには**本文の文字列だけ**を渡す。切り出しと照合が単体テストで
 * 確かめられるようにするためで、`core/textLocate.ts` と同じ考え方である。
 */

/** 再チェックの結果 */
export type RecheckOutcome =
  /** 本文が変わっていない（引用がそのまま残っている）。AIは呼んでいない */
  | { kind: "unchanged" }
  /** 解消した */
  | { kind: "resolved"; reason: string }
  /** まだ当てはまる */
  | { kind: "unresolved"; reason: string }
  /**
   * 確かめられなかった。**指摘はそのまま残す。**
   * 通信の失敗や応答の崩れで、本物の指摘を消してよい理由にはならない
   */
  | { kind: "failed"; reason: string; detail?: string };

/** 再チェックしたい指摘。`ProposalViewItem` から必要な分だけ取る */
export interface RecheckItem {
  /** 検知したときの行（1始まり） */
  line: number;
  /** 指摘が引用していた本文（誤字脱字なら行、推敲なら一文） */
  original: string;
  /** 引用の中で、実際に問題とされた範囲 */
  target: string;
  /** 修正案。**無いことがある**（直し方を作者が決める指摘） */
  suggestion: string;
  /** なぜ直したいか */
  reason: string;
}

/**
 * 該当箇所の前後を、どこまで切り出すか。
 *
 * **チャンク全体は送らない。** 見るのは1件だけなので、前後が分かれば足りる。
 * 小説の本文は1行が1段落のことがあり、行数だけで区切ると長さが読めないため、
 * 字数の上限も併せて持つ。
 */
export const RECHECK_CONTEXT_LINES = 4;
export const RECHECK_CONTEXT_CHARS = 1200;

export interface RecheckExcerpt {
  /** 行番号付きの抜粋 */
  text: string;
  /** 中心にした行（1始まり） */
  line: number;
  /**
   * 引用文で見つけられたか。
   *
   * **false なら、指摘が記録していた行番号を頼りにした。** 本文が書き直された
   * 後なので行番号はずれていることがあり、当てにしすぎない。
   */
  foundByQuote: boolean;
}

/**
 * 指摘が引用した文が、いまの本文にまだそのまま在るか。
 *
 * **在れば、その箇所は書き直されていない。** ここでAIを呼ばずに済ませる。
 *
 * 引用が空なら false を返す。**空の引用は「変わっていない」の証拠にならない**
 * ——何とも照合できていないだけである。
 */
export function isQuoteStillPresent(content: string, quote: string): boolean {
  if (!quote.trim()) return false;
  return findTextRange(content, quote) !== undefined;
}

/**
 * 再チェックのために、該当箇所の前後を切り出す。
 *
 * **まず引用文で探し、見つからなければ行番号の周りを取る。** 本文は
 * 書き直された後なので、行が増減して番号がずれていることがある。
 * 逆に、引用が見つかればそこが確かな中心になる。
 *
 * 見つからないときに**何も返さない**という手もあるが、それでは
 * 「丸ごと書き直した」場合にAIへ何も渡せない。ずれている可能性は
 * `foundByQuote` で呼び出し側へ伝え、抜粋そのものは必ず返す。
 */
export function excerptForRecheck(
  content: string,
  options: {
    quote: string;
    /** 指摘が記録していた行（1始まり） */
    line: number;
    around?: number;
    maxChars?: number;
  }
): RecheckExcerpt {
  const around = options.around ?? RECHECK_CONTEXT_LINES;
  const maxChars = options.maxChars ?? RECHECK_CONTEXT_CHARS;
  // 行番号の数え方を合わせる（`\r\n` を2行と数えない）
  const lines = content.replace(/\r\n?/g, "\n").split("\n");

  const found = options.quote.trim()
    ? findTextRange(content, options.quote)
    : undefined;
  const center = found
    ? found.line
    : Math.min(Math.max(options.line - 1, 0), Math.max(lines.length - 1, 0));

  // **中心の行は、長くても必ず入れる。** ここを落とすと何を見ているのか
  // 分からなくなる。前後は字数の残りが許すぶんだけ広げる
  let from = center;
  let to = center;
  let used = (lines[center] ?? "").length;
  for (let step = 1; step <= around; step++) {
    const above = center - step;
    if (above >= 0 && used + lines[above].length <= maxChars) {
      from = above;
      used += lines[above].length;
    }
    const below = center + step;
    if (below < lines.length && used + lines[below].length <= maxChars) {
      to = below;
      used += lines[below].length;
    }
  }

  return {
    text: lines
      .slice(from, to + 1)
      .map((text, index) => `${from + index + 1}: ${text}`)
      .join("\n"),
    line: center + 1,
    foundByQuote: found !== undefined,
  };
}

export interface RecheckAnswer {
  resolved: boolean;
  /** そう判断した理由。中身の無い言葉なら空になる */
  reason: string;
}

/**
 * AIの答えを読む。
 *
 * **読めなければ undefined を返す。** 呼び出し側は指摘をそのまま残す。
 * 「読めなかった」を「解消した」に丸めると、本物の指摘が黙って消える。
 */
export function parseRecheckAnswer(text: string): RecheckAnswer | undefined {
  const raw = extractJson(text);
  if (!raw) return undefined;

  const resolved = readBoolean(raw.resolved);
  if (resolved === undefined) return undefined;

  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  return {
    resolved,
    // 「なし」「変更不要」のような、指示の言葉がそのまま返ってくる形は
    // この作品で繰り返し起きている（CLAUDE.md）。理由として扱わない
    reason: isPlaceholderText(reason) ? "" : reason,
  };
}

/**
 * 真偽値として読む。
 *
 * スキーマで boolean を指定しているが、**指定を守らないモデルがある。**
 * 文字列で返ってきたぶんは拾い、読めない値は undefined にする
 * （勝手にどちらかへ倒さない）。
 */
function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;

  const body = value
    .trim()
    .toLowerCase()
    .replace(/^[「『"'（(\s]+|[」』"'）)。、\s]+$/gu, "");
  if (TRUE_WORDS.has(body)) return true;
  if (FALSE_WORDS.has(body)) return false;
  return undefined;
}

const TRUE_WORDS = new Set(["true", "yes", "はい", "解消", "解消済み", "解消した"]);
const FALSE_WORDS = new Set(["false", "no", "いいえ", "未解消", "未解決", "残っている"]);

function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface RecheckRequest {
  /**
   * 送信量の記録まで含んだプロバイダ（`AIRegistry.resolve()` の戻り）。
   *
   * **`id` も要る。** 出力上限は「プロバイダ＋モデル」の組で台帳を引く
   * （`ai/outputLimit.ts`）。モデル名だけでは、Ollama と LM Studio が
   * 同じ名前を持てるため別物の実測を拾う
   */
  provider: Pick<AIProvider, "generate" | "id">;
  model: string;
  /** 送信量の記録先。無ければ記録されない */
  workFolder?: string;
  /** どの検知から出た指摘か（「誤字脱字」「推敲」） */
  category: string;
  fileName: string;
  /** いまのファイルの本文。読み込みは呼び出し側が行う */
  content: string;
  item: RecheckItem;
  signal?: AbortSignal;
}

/**
 * 1件を確かめる。
 *
 * 本文がまだ変わっていなければ、**AIを呼ばずに `unchanged` を返す。**
 */
export async function recheckProposal(
  request: RecheckRequest
): Promise<RecheckOutcome> {
  const { item } = request;
  // 引用は広いほう（行・一文）を優先する。**「変わっていない」の証拠としては
  // そちらが強い。** target だけだと、短い語がたまたま他所にも在るだけで
  // 「変わっていない」と言ってしまう
  const quote = item.original.trim() ? item.original : item.target;

  if (isQuoteStillPresent(request.content, quote)) {
    return { kind: "unchanged" };
  }

  const excerpt = excerptForRecheck(request.content, {
    quote,
    line: item.line,
  });

  let text: string;
  try {
    const response = await request.provider.generate({
      systemPrompt: RECHECK_SYSTEM_PROMPT,
      userPrompt: buildRecheckPrompt({
        category: request.category,
        fileName: request.fileName,
        quote,
        target: item.target,
        reason: item.reason,
        suggestion: item.suggestion,
        contextWithLineNumbers: excerpt.text,
      }),
      model: request.model,
      // 判断であって創作ではない。揺らす理由がない
      temperature: 0.0,
      // **見込みと実上限を分けて渡す**（設計書6.77の第2段）。1件につき
      // 1回呼ぶので、渡さないと押した回数だけ設定値ぶんの席を確保する
      maxOutputTokens: resolveOutputTokensForSend(
        request.provider.id,
        request.model
      ),
      plannedOutputTokens: resolveOutputTokensForPlanning(
        request.provider.id,
        request.model
      ),
      jsonSchema: RECHECK_SCHEMA as unknown as object,
      disableThinking: true,
      signal: request.signal,
      // **`numCtx` は渡さない。** 実物から見積もる受け皿（0.22.14）に任せる
      meta: { feature: "recheck", workFolder: request.workFolder },
    });
    if (response.truncated) {
      return { kind: "failed", reason: "応答が途中で切れました。" };
    }
    text = response.text;
  } catch (error) {
    if (error instanceof AIError && error.kind === "aborted") {
      return { kind: "failed", reason: "再チェックを取りやめました。" };
    }
    return {
      kind: "failed",
      reason: "AIに確認できませんでした。",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const answer = parseRecheckAnswer(text);
  if (!answer) {
    return {
      kind: "failed",
      reason: "AIの答えを読み取れませんでした。",
      detail: text.slice(0, 200),
    };
  }

  return answer.resolved
    ? { kind: "resolved", reason: answer.reason }
    : { kind: "unresolved", reason: answer.reason };
}
