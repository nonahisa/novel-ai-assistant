import type { Chunk } from "./chunker";
import type { ExtractedTypoIssue, TypoCheckResult } from "../prompts/typoCheck";
import { normalizeForComparison } from "./groundedEvidence";
import { isPlaceholderText } from "./placeholderText";

/**
 * P-09 誤字脱字検知のAI出力を検証する。
 *
 * これが最も誤検出を出しやすい機能のため、プロンプトで固有名詞を
 * 保護辞書として渡すだけでなく、ここでも二重に弾く。
 * 小さいモデルは指示を無視することがある、という既存の教訓を踏襲した。
 */

export type TypoRejectionReason =
  | "invalid_shape"
  | "out_of_range"
  | "ungrounded"
  | "target_not_in_original"
  | "protected_term"
  /** 修正案が「空文字」「なし」など、中身の無いことを書いた言葉 */
  | "placeholder_suggestion";

export interface RejectedTypoIssue {
  line: number | null;
  target: string | null;
  reason: TypoRejectionReason;
}

export interface AcceptedTypoIssue {
  line: number;
  original: string;
  target: string;
  suggestion: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export interface TypoValidationResult {
  accepted: AcceptedTypoIssue[];
  rejected: RejectedTypoIssue[];
}

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * 構造化出力でも前後に説明やコードフェンスが付くモデルがあるため、
 * 生のJSON、コードフェンス除去、最外の波括弧抽出の順で解析する。
 * `characterExtractionValidation.ts` の `parseResult` と同じ方式。
 */
export function parseTypoCheckResult(text: string): TypoCheckResult | null {
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
        return parsed as unknown as TypoCheckResult;
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

/**
 * @param protectedNames 固有名詞辞書（人物・場所・能力・組織の name + aliases）。
 *   プロンプトでも渡しているが、指示に従わないモデルがあるため
 *   ここでも `target` が完全一致するものを弾く。
 */
export function validateTypoIssues(
  raw: unknown,
  chunk: Chunk,
  protectedNames: string[]
): TypoValidationResult {
  const accepted: AcceptedTypoIssue[] = [];
  const rejected: RejectedTypoIssue[] = [];

  if (!isRecord(raw) || !Array.isArray(raw.issues)) {
    rejected.push({ line: null, target: null, reason: "invalid_shape" });
    return { accepted, rejected };
  }

  const protectedSet = new Set(
    protectedNames.map((name) => name.trim()).filter(Boolean)
  );
  const chunkLineCount = chunk.text.split("\n").length;
  const firstLine = chunk.startLine + 1;
  const lastLine = chunk.startLine + chunkLineCount;
  const normalizedChunk = normalizeForComparison(chunk.text);

  for (const candidate of raw.issues as unknown[]) {
    const issue = parseIssue(candidate);
    if (!issue) {
      rejected.push({ line: null, target: null, reason: "invalid_shape" });
      continue;
    }

    if (issue.line < firstLine || issue.line > lastLine) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "out_of_range",
      });
      continue;
    }

    // AIの幻覚を防ぐ：original が本文中に逐語で実在しない指摘は破棄する
    if (!normalizedChunk.includes(normalizeForComparison(issue.original))) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "ungrounded",
      });
      continue;
    }

    // target が original の中に含まれていないと、適用時に置換位置を特定できない
    if (!issue.original.includes(issue.target)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "target_not_in_original",
      });
      continue;
    }

    if (protectedSet.has(issue.target)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "protected_term",
      });
      continue;
    }

    // **AIが「中身が無い」ことを中身として書いてくる。**
    // 推敲で `"suggestion": "空文字"` が返り、押すと本文がその3文字に
    // 置き換わるところだった（2026-08-17、実データ）。
    // 誤字脱字は直し方が必ずあるはずなので、指摘ごと落とす
    if (isPlaceholderText(issue.suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "placeholder_suggestion",
      });
      continue;
    }

    accepted.push({
      line: issue.line,
      original: issue.original,
      target: issue.target,
      suggestion: issue.suggestion,
      reason: issue.reason,
      confidence: VALID_CONFIDENCE.has(issue.confidence)
        ? (issue.confidence as "high" | "medium" | "low")
        : "low",
    });
  }

  return { accepted, rejected };
}

function parseIssue(raw: unknown): ExtractedTypoIssue | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.line !== "number" || !Number.isInteger(raw.line)) return null;
  const original = cleanRequiredString(raw.original);
  const target = cleanRequiredString(raw.target);
  const suggestion = cleanRequiredString(raw.suggestion);
  if (!original || !target || !suggestion) return null;
  return {
    line: raw.line,
    original,
    target,
    suggestion,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    confidence: typeof raw.confidence === "string" ? raw.confidence : "low",
  };
}

function cleanRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
