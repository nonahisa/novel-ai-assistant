import {
  VERIFY_REJECT_REASONS,
  VERIFY_SPEECH_KEEP_SENTENCES,
  type VerifyRejectReason,
} from "../prompts/contradictionVerify";
import { normalizeForComparison } from "./groundedEvidence";

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
  if (echoesSpeechKeep(explanation)) {
    // **「残せ」と頼んだ文を写したまま却下してきた**（P-12b 1.1）。指示の言葉が
    // 答えの中身として返る型で、自分の説明と判定が逆を向いている。消す根拠に
    // ならないので、判断できなかったものとして通す
    return undecidedOutcome(explanation);
  }
  return { keep: false, reason, explanation, confidence, undecided: false };
}

/**
 * 説明が、口調の但し書き（P-12b 1.1）の「残せ」の文を丸ごと写しているか。
 *
 * 文の一部の一致は見ない。「変わり型」「語尾」のような語は、罠（語尾は違うが
 * 話し方は同じ）の正しい却下の説明にも出るので、語で見ると正しい却下まで
 * 通してしまう。
 */
function echoesSpeechKeep(explanation: string): boolean {
  const field = normalizeForComparison(explanation);
  if (!field) return false;
  return VERIFY_SPEECH_KEEP_SENTENCES.some((sentence) =>
    field.includes(normalizeForComparison(sentence))
  );
}

/** 取り下げの指摘を読むのに要る欄（`AcceptedContradiction` の一部） */
export interface WithdrawnIssueFields {
  excerpt: string;
  textSays: string;
  note: string;
}

/** 台詞だと読める手がかり。括弧か、検出の段が書く「発言者が…」の言い回し */
const SPEECH_CLUE = /[「『]|発言者|台詞|セリフ|嘘|偽っ|思い違い|勘違い/;

/**
 * 確かめの段が取り下げた指摘のうち、消さずに確信度 low で残すものを決める
 * （2026-10-19、作者の裁定の案2A。設計書6.10.5）。
 *
 * 検出の段は、あとの話で分かる事実と台詞が食い違うとき「確信度を low にして、
 * 発言者が知らない／偽っている可能性と書け」と頼む。ところが確かめの段は同じ
 * 指摘を「発言者の誤り」として消し、作者が見る前に無くなっていた。二つの段の
 * 言うことを揃えるため、**あとの話から来た（future）台詞が「発言者の誤り」で
 * 取り下げられたときだけ**残す。
 *
 * - 「まだ明かされていない」は対象にしない（「この人物はまだ知らない」という
 *   正しい取り下げがありうるので、作者の裁定で外した）
 * - 本命の突き合わせ（settled）は対象にしない。過去の場面との食い違いを
 *   発言者の誤りで消すのは正しい仕事である
 * - 地の文は対象にしない
 *
 * 返すのは上書きする欄だけ。残さないときは undefined。AI は呼ばない。
 * 画面（`features/checkContradictions`）と MCP の両方がここを通る。
 */
export function keepWithdrawnSpeechAsLow(
  issue: WithdrawnIssueFields,
  outcome: VerifyOutcome,
  source: "settled" | "future"
): { confidence: "low"; note: string } | undefined {
  if (source !== "future") return undefined;
  if (outcome.keep || outcome.reason !== "発言者の誤り") return undefined;
  const clue = `${issue.excerpt}\n${issue.textSays}\n${issue.note}`;
  if (!SPEECH_CLUE.test(clue)) return undefined;

  const why = outcome.explanation.trim();
  const added =
    "確かめの段は発言者の誤りとして取り下げましたが、" +
    "嘘や思い違いの可能性として残します" +
    (why ? `（検証: ${why}）` : "");
  const base = issue.note.trim();
  return { confidence: "low", note: base ? `${base}（${added}）` : added };
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
