import {
  SUBTITLE_MAX_CHARS,
  SYNOPSIS_MAX_CHARS,
  type SubtitleSuggestion,
  type SynopsisResult,
} from "../prompts/synopsis";
import { clampSummary } from "./summaryLimit";
import type { ChapterEmotion } from "../models/synopsis";

/**
 * あらすじとサブタイトル案の検証。
 *
 * **AIの出力を信用しない**（CLAUDE.md）。字数はここで数え直し、
 * ファイル名に使えない文字もここで落とす。サブタイトルは
 * そのままファイル名になるため、通してはいけないものが1つでも
 * 混ざると作者の原稿ファイルが壊れる。
 */

/** ファイル名に使えない文字。Windowsを基準にする */
const FORBIDDEN_IN_FILENAME = /[\\/:*?"<>|]/;
/** 制御文字と、末尾に置けない文字 */
const CONTROL_CHARS = /[\u0000-\u001f]/;

export interface ValidatedSynopsis {
  synopsis: string;
  subtitles: SubtitleSuggestion[];
  /** 落とした案とその理由。作者に何が起きたか示すために残す */
  rejectedSubtitles: Array<{ text: string; reason: SubtitleRejectionReason }>;
  /**
   * 感情の測り。範囲外は丸め、読めなければ null。
   *
   * **数値の検証はコード側で行う。** AIは「0〜10」と指示しても
   * 12 や -1 を返すことがあり、そのままグラフに渡すと軸からはみ出す。
   */
  emotion: ChapterEmotion | null;
}

export type SubtitleRejectionReason =
  | "too_long"
  | "empty"
  | "forbidden_char"
  | "duplicate";

/** 応答のJSONを、この機能が扱う形に整える */
export function parseSynopsisResult(text: string): SynopsisResult | null {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.synopsis !== "string") return null;

  const subtitles = Array.isArray(raw.subtitles)
    ? raw.subtitles
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry)
        )
        .filter((entry) => typeof entry.text === "string")
        .map((entry) => ({
          text: entry.text as string,
          kind: typeof entry.kind === "string" ? entry.kind : "",
          reason: typeof entry.reason === "string" ? entry.reason : null,
        }))
    : [];

  return {
    synopsis: raw.synopsis,
    subtitles,
    confidence: typeof raw.confidence === "string" ? raw.confidence : "low",
  };
}

/**
 * コードフェンスを外す。
 *
 * 「フェンスを付けるな」と指示しても付けてくる。
 * JSONスキーマを渡せない構成でも動くよう、ここで落としておく。
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fence ? fence[1] : trimmed;
}

/**
 * あらすじとサブタイトル案を検証する。
 *
 * あらすじは切り詰める（長い＝内容は正しいことが多く、捨てるには惜しい）。
 * サブタイトルは切り詰めない。**途中で切れた言葉はサブタイトルにならない**ので、
 * 上限を超えたものは落として、残った案から作者に選ばせる。
 */
export function validateSynopsisResult(
  result: SynopsisResult
): ValidatedSynopsis {
  // 空のあらすじは「生成できなかった」として扱えるよう、空文字で返す
  const synopsis = clampSummary(result.synopsis, SYNOPSIS_MAX_CHARS) ?? "";

  const subtitles: SubtitleSuggestion[] = [];
  const rejected: ValidatedSynopsis["rejectedSubtitles"] = [];
  const seen = new Set<string>();

  for (const candidate of result.subtitles) {
    const text = candidate.text.trim().replace(/\s+/g, " ");
    if (text.length === 0) {
      rejected.push({ text: candidate.text, reason: "empty" });
      continue;
    }
    if (text.length > SUBTITLE_MAX_CHARS) {
      rejected.push({ text, reason: "too_long" });
      continue;
    }
    if (FORBIDDEN_IN_FILENAME.test(text) || CONTROL_CHARS.test(text)) {
      rejected.push({ text, reason: "forbidden_char" });
      continue;
    }
    if (seen.has(text)) {
      rejected.push({ text, reason: "duplicate" });
      continue;
    }
    seen.add(text);
    subtitles.push({ ...candidate, text });
  }

  return {
    synopsis,
    subtitles,
    rejectedSubtitles: rejected,
    emotion: validateEmotion(result.emotion),
  };
}

/**
 * 感情の測りを検証する。
 *
 * AIは「0〜10の整数」と指示しても、12や-1、小数を返すことがある。
 * **範囲外は捨てずに丸める。** グラフの軸からはみ出さなければよく、
 * 捨てるとその話だけ曲線が途切れて、かえって読み取りにくい。
 */
function validateEmotion(raw: unknown): ChapterEmotion | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;

  const intensity = clampNumber(value.intensity, 0, 10);
  const valence = clampNumber(value.valence, -5, 5);
  // 2つとも読めなければ、点として打てない
  if (intensity === null || valence === null) return null;

  const dominant =
    value.dominant === "喜" ||
    value.dominant === "怒" ||
    value.dominant === "哀" ||
    value.dominant === "楽"
      ? value.dominant
      : null;

  const reason = typeof value.reason === "string" ? value.reason.trim() : "";

  return {
    intensity,
    valence,
    dominant,
    // 理由が長いと表が読みにくい。切り詰めても意味は伝わる
    reason: reason.length > 40 ? `${reason.slice(0, 40)}…` : reason,
  };
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 落とした理由を作者向けの言葉にする */
export function describeSubtitleRejection(
  reason: SubtitleRejectionReason
): string {
  switch (reason) {
    case "too_long":
      return `${SUBTITLE_MAX_CHARS}字を超えている`;
    case "empty":
      return "中身が空";
    case "forbidden_char":
      return "ファイル名に使えない文字を含む";
    case "duplicate":
      return "同じ案が重複";
  }
}
