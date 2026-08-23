import {
  VERIFY_REJECT_REASONS,
  type VerifyRejectReason,
} from "../prompts/contradictionVerify";

/**
 * 矛盾の検証結果を読む（設計書6.10.5）。
 *
 * **読めなければ採用する。** 検証は「誤った指摘を減らす」ための工程で
 * あって、**通信の失敗や応答の崩れで本物の指摘を消してよい理由にはならない。**
 * 判断できなかったものは、これまでどおり作者へ出す。
 *
 * VS Code APIに依存しない。
 */

export interface VerifyOutcome {
  /** 採用するか */
  keep: boolean;
  /** 却下の理由。採用なら undefined */
  reason?: VerifyRejectReason;
  /** そう判断した説明 */
  explanation: string;
  confidence: "high" | "medium" | "low";
  /** 応答を読めなかったので、判断せず通したか */
  undecided: boolean;
}

const LEVELS = new Set(["high", "medium", "low"]);

/** 判断できなかったときの答え。**通す側へ倒す** */
export function undecidedOutcome(explanation = ""): VerifyOutcome {
  return { keep: true, explanation, confidence: "low", undecided: true };
}

export function parseVerifyOutcome(text: string): VerifyOutcome {
  const raw = extractJson(text);
  if (!raw) return undecidedOutcome("応答を読み取れませんでした");

  const verdict = asString(raw.verdict);
  const explanation = asString(raw.explanation);
  const confidence = LEVELS.has(asString(raw.confidence))
    ? (asString(raw.confidence) as "high" | "medium" | "low")
    : "low";

  // **「採用」以外を却下と読まない。** 空や知らない語で消すと、
  // 応答が少し崩れただけで本物の指摘が消える
  if (verdict === "採用") {
    return { keep: true, explanation, confidence, undecided: false };
  }
  if (verdict !== "却下") {
    return undecidedOutcome(explanation || `判定が読めません（${verdict}）`);
  }

  const reason = normalizeReason(asString(raw.reason));
  if (!reason) {
    // **理由の無い却下は受け取らない。** 何を根拠に消したのかが残らないと、
    // 作者は「なぜ出ないのか」を追えない
    return undecidedOutcome(explanation || "却下の理由がありません");
  }
  return { keep: false, reason, explanation, confidence, undecided: false };
}

function normalizeReason(value: string): VerifyRejectReason | undefined {
  const trimmed = value.trim();
  return (VERIFY_REJECT_REASONS as readonly string[]).includes(trimmed)
    ? (trimmed as VerifyRejectReason)
    : undefined;
}

/**
 * 検証の結果を、作者へ見せる言葉にする。
 *
 * **何件消したかを黙らない。** 消した理由の内訳が見えないと、
 * 「指摘が少ない」のか「消しすぎている」のかを作者が判断できない。
 */
export function describeVerifyResults(
  rejected: ReadonlyArray<{ reason?: VerifyRejectReason }>,
  undecided: number
): string {
  if (rejected.length === 0 && undecided === 0) return "";

  const byReason = new Map<string, number>();
  for (const entry of rejected) {
    const key = entry.reason ?? "理由なし";
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }

  const parts: string[] = [];
  if (rejected.length > 0) {
    const breakdown = [...byReason]
      .sort((left, right) => right[1] - left[1])
      .map(([reason, count]) => `${reason} ${count}件`)
      .join("、");
    parts.push(`検証で ${rejected.length}件を取り下げ（${breakdown}）`);
  }
  if (undecided > 0) {
    // 判断できなかったものは通してある。伏せない
    parts.push(`${undecided}件は検証できず、そのまま残しました`);
  }
  return parts.join(" / ");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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
