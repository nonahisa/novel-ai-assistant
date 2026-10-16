import {
  VERIFY_REJECT_REASONS,
  VERIFY_SPEECH_KEEP_SENTENCES,
  type VerifyRejectReason,
} from "../prompts/contradictionVerify";
import { normalizeForComparison } from "./groundedEvidence";
import { lookupKnownAtValue } from "./contradictionValidation";

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

/**
 * 「まだ明かされていない」で取り下げるとき、作者へ残す説明。
 *
 * **AIの説明はそのまま残さない。** 2026-10-16 の実例は「一人称の設定が不明」で、
 * 資料には一人称がある。そのまま補足へ足すと、作者に誤った読みを渡す。
 */
export const NOT_YET_REVEALED_UNFOUNDED_NOTE =
  "この話より後で明かされる設定だという記録が無いため、「まだ明かされていない」の却下は受け取らずに残しました";

/**
 * 「まだ明かされていない」の却下に、話数の裏付けがあるか（2026-10-16）。
 *
 * **検出へ渡す材料は、その話の時点で分かっていることだけ**（設計書6.10.3）なので、
 * 却下が正しいのは「この設定は対象より後の話で分かる」と言える記録があるときだけ
 * である。記録が無い（空を含む）・あっても対象の話以前なら、その却下は根拠が無い。
 *
 * **空も根拠の無い側に入れる。** 索引（`buildKnownAtIndex`）は変化の記録の値と
 * 完全に一致するときしか話数を返さず、検出の段は「一人称: ボク」の形で書くので、
 * 実データでは空が普通である。そのとき検証のプロンプトには「（不明）」と入り、
 * gemma4:26b はこれを「設定が不明」と読んで、正しい指摘を3回とも取り下げた
 * （「第3話」を渡すと3回とも採用。`docs/measurements/2026-10-16-ai-measure.md`）。
 *
 * **判断できなかったものとして通す**（`echoesSpeechKeep` と同じ作法）。消す根拠が
 * 無い却下で、本物の指摘を作者から隠さない。
 *
 * **答えを覚えた後にかける。** 製品は検証の答えをキャッシュしており、ここを
 * 読み取りのあとに置けば、版を上げなくても前に覚えた却下にも効く。
 *
 * @param targetChapter 対象の話（まとめたチャンクはいちばん前の話）。分からなければ
 *   null で、そのときは材料も話数で絞れていないので手を付けない
 */
export function guardNotYetRevealed(
  outcome: VerifyOutcome,
  knownAt: ReadonlyMap<string, number[]>,
  settingSays: string,
  targetChapter: number | null
): VerifyOutcome {
  if (outcome.keep || outcome.reason !== "まだ明かされていない") return outcome;
  if (targetChapter === null) return outcome;
  const chapters = lookupKnownAtValue(knownAt, settingSays);
  if (chapters.some((chapter) => chapter > targetChapter)) return outcome;
  return undecidedOutcome(NOT_YET_REVEALED_UNFOUNDED_NOTE);
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
