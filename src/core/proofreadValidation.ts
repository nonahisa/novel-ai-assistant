import type { Chunk } from "./chunker";
import { normalizeForComparison } from "./groundedEvidence";
import { isPlaceholderText } from "./placeholderText";
import {
  issueBudget,
  PROOFREAD_REASONS,
  type ProofreadReason,
} from "../prompts/proofread";

/**
 * 推敲の提案の検証（設計書6.9.1）。
 *
 * **この機能でいちばん危ないのは、出しすぎること。**
 * 誤字脱字には正解があるが、推敲には無い。AIはどの文にも何かしら言えるので、
 * 放っておくと**全部の文に提案が付く**。作者は読むだけで疲れて、
 * 機能ごと使わなくなる。
 *
 * したがってここでは、
 *
 * - **件数を機械的に切る**（1000字あたり3件）。プロンプトでも言うが守らない
 * - **確信度の高いものから残す。** 切るときに迷っている提案が残ると、
 *   質の低いものだけが手元に来る
 * - 決めた4種類以外の理由を弾く（文体への干渉が紛れ込む口を塞ぐ）
 * - **変わっていない提案を弾く。** 原文と同じものを「修正案」として返す
 *
 * VS Code APIに依存しない。
 */

export interface AcceptedProofreadIssue {
  line: number;
  original: string;
  /** 置き換える範囲。推敲では原文まるごと */
  target: string;
  suggestion: string;
  reason: ProofreadReason;
  explanation: string;
  confidence: "high" | "medium" | "low";
}

export interface RejectedProofreadIssue {
  raw: unknown;
  reason:
    | "shape"
    | "line_out_of_range"
    | "original_not_found"
    | "unknown_reason"
    | "no_change"
    /** 件数の上限を超えた */
    | "over_budget"
    /** 「長文」の札だが、当てはまる一文が無い */
    | "not_long"
    /** 「同語反復」の札だが、繰り返しが無い */
    | "not_repeated"
    /** 「同語反復」の札だが、台詞の中＝人物の話し方である */
    | "dialogue_voice"
    /** 説明が、禁じた観点（語彙・文体など）を語っている */
    | "forbidden_aspect";
}

const LEVELS = new Set(["high", "medium", "low"]);
const REASON_SET = new Set<string>(PROOFREAD_REASONS);

/**
 * 「長文」の目安（プロンプト設計書P-10）。**一文が80字を超え、読点が5個以上。**
 */
const LONG_SENTENCE_CHARS = 80;
const LONG_SENTENCE_COMMAS = 5;

/**
 * 「長文」の札が、本当に長文に貼られているか。
 *
 * **実データで、長文でない箇所に貼られていた**（2026-08-16）。
 * 「文の区切りが連続しており、流れがやや急ぎ足」のような**文体の話**に
 * この札が付いてくる。**禁じたはずの干渉が、許した札で入ってくる。**
 *
 * 長文だけは目安が数で決まっているので、コードで確かめられる。
 * 当てはまる一文が無ければ、それは長文の指摘ではない。
 */
export function hasLongSentence(text: string): boolean {
  // 句点・感嘆符・疑問符で文に割る（閉じ括弧が続く場合はそこまで）
  for (const sentence of text.split(/(?<=[。！？])[」』）]*/)) {
    const body = sentence.trim();
    if (body.length <= LONG_SENTENCE_CHARS) continue;
    const commas = (body.match(/[、，]/g) ?? []).length;
    if (commas >= LONG_SENTENCE_COMMAS) return true;
  }
  return false;
}

/**
 * 「同語反復」の札が、本当に繰り返しに貼られているか。
 *
 * 長文と同じく、実データで**繰り返しの無い箇所に貼られていた**
 * （「『ばっちり』という表現が文脈に合わない」）。
 * 繰り返しは数えられるので、コードで確かめる。
 *
 * 3文字を境にするのは、日本語では2文字の並び（「して」「ている」）が
 * どの文にも出るためである。
 */
const REPEAT_MIN_LENGTH = 3;

export function hasRepetition(text: string): boolean {
  const body = text.replace(/\s/g, "");
  for (let start = 0; start + REPEAT_MIN_LENGTH <= body.length; start++) {
    const piece = body.slice(start, start + REPEAT_MIN_LENGTH);
    if (body.indexOf(piece, start + REPEAT_MIN_LENGTH) >= 0) return true;
  }
  return false;
}

/**
 * 指摘の当たっている先が、まるごと台詞かどうか。
 *
 * **台詞の中の繰り返しは、文章の癖ではなく人物の話し方である。**
 * 作者の10作品で測ったところ（2026-08-17）、`同語反復` として挙がった
 * ものの多くが台詞だった。
 *
 * - 「あんた、クォーターやろ？　なんゆうてまんのや？」→ **関西弁**
 * - 「わた、く、しは、で　んかを、あいして　い ます……」→ **わざと崩した喋り**
 * - 「商人は帝国を打倒したりせぇへん。……商人は商人らしく」→ **強調の反復**
 *
 * どれも直したら人物が壊れる。地の文の重複とは別物なので、ここで切る。
 *
 * 地の文が少しでも混じっていれば台詞だけの指摘ではないので、通す。
 * 「ある者は……ある者は」のような**地の文の対句は作者に見せる**
 * （直すかどうかは作者が決めることで、機械が決めることではない）。
 */
export function isDialogueOnly(text: string): boolean {
  // 台詞を取り除いた残りに、意味のある文字が残るか
  const outside = text
    .replace(/[「『][^」』]*[」』]?/gu, "")
    // 閉じ括弧が先に来る形（台詞の途中を抜き出した場合）も落とす
    .replace(/^[^「『]*[」』]/u, "")
    .replace(/[\s　、。！？…―ー）\)]/gu, "");
  return outside.length === 0 && /[「『]/u.test(text);
}

/**
 * 説明が、禁じた観点を語っていないか。
 *
 * **実データで、語彙や文体の指摘が許した札を着て入ってきた**
 * （「『なんか』が口語的」に`係り受け`の札、「表現が文脈に合わない」に
 * `同語反復`の札）。**札だけ見ていると素通りする。**
 *
 * 矛盾検知で「矛盾していません」を弾いたのと同じ形の防ぎ方である。
 */
const FORBIDDEN_EXPLANATION =
  /(口語|文語|語彙|言い回しが|表現が|語感|リズム|テンポ|文体|描写|余韻|唐突|不自然|物足りな|くどい印象|やや古|硬い|柔らか)/;

export function mentionsForbiddenAspect(explanation: string): boolean {
  return FORBIDDEN_EXPLANATION.test(explanation);
}

export function parseProofreadResult(
  text: string
): { issues: unknown[] } | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed) && Array.isArray(parsed.issues)) {
        return { issues: parsed.issues };
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

export function validateProofreadIssues(
  raw: unknown,
  chunk: Chunk
): {
  accepted: AcceptedProofreadIssue[];
  rejected: RejectedProofreadIssue[];
} {
  const accepted: AcceptedProofreadIssue[] = [];
  const rejected: RejectedProofreadIssue[] = [];

  const list = isRecord(raw) && Array.isArray(raw.issues) ? raw.issues : [];
  const normalizedChunk = normalizeForComparison(chunk.text);
  const lineCount = chunk.text.split("\n").length;
  const firstLine = chunk.startLine + 1;
  const lastLine = chunk.startLine + lineCount;

  const passed: AcceptedProofreadIssue[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }

    const original = asString(item.original);
    const suggestion = asString(item.suggestion);
    const reason = normalizeReason(asString(item.reason));
    const line = typeof item.line === "number" ? Math.round(item.line) : NaN;

    // **修正案が無くてもよい。** 長すぎる文をどう割るか、繰り返しをどう
    // 変えるかは文体の書き換えになる。**それは作者が決めること**なので、
    // 「ここが読みにくい」と指す指摘にも意味がある（実データで、
    // 「一閃っ一閃っ一閃っ！」のように直しようのない指摘が返ってきた）
    if (!original || !Number.isFinite(line)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }
    if (!reason) {
      // 決めた4種類以外は、文体への干渉が紛れ込む口になる
      rejected.push({ raw: item, reason: "unknown_reason" });
      continue;
    }
    // **「長文」だけは数で決まるので、確かめられる。**
    // 当てはまる一文が無ければ、それは長文の指摘ではない
    if (reason === "長文" && !hasLongSentence(original)) {
      rejected.push({ raw: item, reason: "not_long" });
      continue;
    }
    // 「同語反復」も数えられる。繰り返しが無ければ、それは別の指摘である
    if (reason === "同語反復" && !hasRepetition(original)) {
      rejected.push({ raw: item, reason: "not_repeated" });
      continue;
    }
    // **台詞の中の繰り返しは人物の話し方である。** 方言も、わざと崩した
    // 喋りも、強調の反復も、直したら人物が変わってしまう
    if (reason === "同語反復" && isDialogueOnly(original)) {
      rejected.push({ raw: item, reason: "dialogue_voice" });
      continue;
    }
    // **札ではなく中身を見る。** 語彙や文体の話が、許した札を着て入ってくる
    if (mentionsForbiddenAspect(asString(item.explanation))) {
      rejected.push({ raw: item, reason: "forbidden_aspect" });
      continue;
    }
    if (line < firstLine || line > lastLine) {
      rejected.push({ raw: item, reason: "line_out_of_range" });
      continue;
    }
    // **原文が本文に実在するかを見る。** 言い換えた「原文」を返すことがあり、
    // そのまま適用すると本文のどこにも当たらない
    if (!normalizedChunk.includes(normalizeForComparison(original))) {
      rejected.push({ raw: item, reason: "original_not_found" });
      continue;
    }
    // **「空文字」という3文字を修正案として返してくる。**
    // プロンプトの「空文字にしてください」をそのまま書いたもので、
    // 押すと本文の一文がその3文字に置き換わる（2026-08-17、実データ）。
    // 中身が無いという意味なので、指摘としては残し、修正案だけ空にする
    const usableSuggestion = isPlaceholderText(suggestion, true)
      ? ""
      : suggestion;
    // 原文と同じものを「修正案」として返してくる。押しても何も起きない。
    // **空は別物**（直し方を作者に委ねる指摘であって、間違いではない）
    if (
      usableSuggestion &&
      normalizeForComparison(original) ===
        normalizeForComparison(usableSuggestion)
    ) {
      rejected.push({ raw: item, reason: "no_change" });
      continue;
    }

    passed.push({
      line,
      original,
      // 推敲は原文まるごとを置き換える（誤字脱字のような部分置換ではない）
      target: original,
      suggestion: usableSuggestion,
      reason,
      explanation: asString(item.explanation),
      confidence: level(item.confidence),
    });
  }

  // **件数を切る。** ここが無いと、全部の文に提案が付いた状態が作者へ届く
  const budget = issueBudget(chunk.text.length);
  const ordered = sortProofreadIssues(passed);
  accepted.push(...ordered.slice(0, budget));
  for (const extra of ordered.slice(budget)) {
    rejected.push({ raw: extra, reason: "over_budget" });
  }

  return { accepted, rejected };
}

/**
 * 見せる順を決める。
 *
 * **確信度の高いものを先に。** 上限で切るとき、迷っている提案が残ると
 * 質の低いものだけが作者の手元に来る。
 */
export function sortProofreadIssues(
  items: AcceptedProofreadIssue[]
): AcceptedProofreadIssue[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...items].sort((left, right) => {
    if (left.confidence !== right.confidence) {
      return rank[left.confidence] - rank[right.confidence];
    }
    return left.line - right.line;
  });
}

/**
 * 理由を1つに決める。
 *
 * 矛盾検知と同じく、**選択肢をそのまま写して返してくる**ことがある
 * （実データで起きた。設計書6.10.1）。両方で受ける。
 */
export function normalizeReason(raw: string): ProofreadReason | undefined {
  const trimmed = raw.trim();
  if (REASON_SET.has(trimmed)) return trimmed as ProofreadReason;
  for (const candidate of PROOFREAD_REASONS) {
    if (trimmed.startsWith(candidate)) return candidate;
  }
  for (const candidate of PROOFREAD_REASONS) {
    if (trimmed.includes(candidate)) return candidate;
  }
  return undefined;
}

function level(raw: unknown): "high" | "medium" | "low" {
  const value = asString(raw);
  return LEVELS.has(value) ? (value as "high" | "medium" | "low") : "low";
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
