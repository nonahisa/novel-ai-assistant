import { normalizeForComparison } from "./groundedEvidence";
import {
  deviationBudget,
  DEVIATION_TYPES,
  type DeviationType,
} from "../prompts/deviationCheck";

/**
 * プロット逸脱・間延びの指摘の検証（設計書6.10.2）。
 *
 * **今日ここまでで2度同じ失敗をしている**（矛盾検知・推敲）。
 * どちらも「AIが材料側の文を引いて本文だと言う」「許した札に禁じた中身を
 * 入れる」だった。**最初から同じ手当てを入れる。**
 *
 * この機能に固有の危うさは、**照らし合わせた先が実在しないこと**である。
 * 「プロットの『主人公の成長』と照らして…」と言われても、プロットに
 * そんな項目が無ければ、その指摘は根拠を持たない。
 * `plotReference` がプロットに実在するかを確かめる。
 *
 * VS Code APIに依存しない。
 */

export interface AcceptedDeviation {
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  type: DeviationType;
  reason: string;
  plotReference: string;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
}

export interface RejectedDeviation {
  raw: unknown;
  reason:
    | "shape"
    | "line_out_of_range"
    | "excerpt_not_found"
    | "unknown_type"
    /** 照らしたプロットの語句が、プロットに無い */
    | "plot_reference_not_found"
    /** 件数の上限を超えた */
    | "over_budget"
    /** 引用が長すぎる（段落をまるごと写している） */
    | "excerpt_too_long"
    /** 理由が「これは逸脱ではない」と言っている */
    | "self_denied";
}

const LEVELS = new Set(["high", "medium", "low"]);
const TYPE_SET = new Set<string>(DEVIATION_TYPES);

/**
 * 引用の長さの上限。
 *
 * プロンプトでは30字以内と言っているが、**実データで数百字の塊を
 * 返してきた**（第9話。段落をまるごと写していた）。
 * それは引用ではなく、どこを指しているのか分からない。
 */
const MAX_EXCERPT_CHARS = 80;

/**
 * 「これは逸脱ではない」と自分で書いている指摘を見分ける。
 *
 * **実データで返ってきた。**「プロットの…事象自体は**カバーしています**」
 * と書きながら指摘として並べる。矛盾検知で「矛盾していません」を弾いたのと
 * 同じことが、ここでも起きる。
 *
 * **「背景説明」「描写として追加」も落とす。** プロンプトで
 * 「伏線・掘り下げ・テーマの補強・背景の説明は逸脱ではない」と言っており、
 * **自分でそう書いているものは、自分で否定している。**
 */
const NOT_A_DEVIATION =
  /(カバーして|網羅して|沿って(い|お)|一致して|逸脱で(は)?(あり)?(ませ|ない)|問題(は)?(あり)?ませ|背景(の)?説明|描写として(追加|補)|掘り下げ|補強|伏線)/;

export function deniesDeviation(reason: string): boolean {
  return NOT_A_DEVIATION.test(reason);
}

/**
 * 照らした先が、プロットに実在するか。
 *
 * **無いものを引いて指摘してくる。** 矛盾検知では設定資料の文を、
 * 推敲では言い換えた「原文」を引いてきた。ここでも同じことが起きうる。
 *
 * ただし**語句そのままとは限らない**（プロットの「あらすじ」節を指して
 * 「あらすじ」と書くなど）。**見出しの名前も実在として認める。**
 */
export function referencesPlot(plotReference: string, plot: string): boolean {
  const reference = normalizeForComparison(plotReference);
  if (!reference) return false;
  const normalizedPlot = normalizeForComparison(plot);
  if (normalizedPlot.includes(reference)) return true;

  // 「## あらすじ」のような見出しを指しているだけの場合も通す。
  // 引用ではないが、照らした先としては特定できている
  const headings = [...plot.matchAll(/^#{1,6}\s*(.+?)\s*$/gm)].map((match) =>
    normalizeForComparison(match[1])
  );
  return headings.some(
    (heading) => heading && (reference.includes(heading) || heading === reference)
  );
}

export function parseDeviationResult(
  text: string
): { deviations: unknown[] } | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed) && Array.isArray(parsed.deviations)) {
        return { deviations: parsed.deviations };
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

export function validateDeviations(
  raw: unknown,
  episode: { text: string; plot: string }
): { accepted: AcceptedDeviation[]; rejected: RejectedDeviation[] } {
  const accepted: AcceptedDeviation[] = [];
  const rejected: RejectedDeviation[] = [];

  const list =
    isRecord(raw) && Array.isArray(raw.deviations) ? raw.deviations : [];
  const normalizedText = normalizeForComparison(episode.text);
  const lastLine = episode.text.split("\n").length;

  const passed: AcceptedDeviation[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }

    const excerpt = asString(item.excerpt);
    const reason = asString(item.reason);
    const plotReference = asString(item.plotReference);
    const type = normalizeType(asString(item.type));
    const lineStart =
      typeof item.lineStart === "number" ? Math.round(item.lineStart) : NaN;
    const lineEndRaw =
      typeof item.lineEnd === "number" ? Math.round(item.lineEnd) : NaN;

    if (!excerpt || !reason || !Number.isFinite(lineStart)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }
    if (!type) {
      rejected.push({ raw: item, reason: "unknown_type" });
      continue;
    }
    // **段落をまるごと写してくる。** それは引用ではなく、
    // どこを指しているのか分からない
    if (excerpt.length > MAX_EXCERPT_CHARS) {
      rejected.push({ raw: item, reason: "excerpt_too_long" });
      continue;
    }
    // **「これは逸脱ではない」と自分で書いているものを通さない**
    if (deniesDeviation(reason)) {
      rejected.push({ raw: item, reason: "self_denied" });
      continue;
    }
    if (lineStart < 1 || lineStart > lastLine) {
      rejected.push({ raw: item, reason: "line_out_of_range" });
      continue;
    }
    // **引用が本文に実在するかを見る。** プロットの文をそのまま引いて
    // 「本文にこうある」と言うことがある（矛盾検知で実際に起きた）
    if (!normalizedText.includes(normalizeForComparison(excerpt))) {
      rejected.push({ raw: item, reason: "excerpt_not_found" });
      continue;
    }
    // **照らした先がプロットに無ければ、その指摘は根拠を持たない**
    if (!referencesPlot(plotReference, episode.plot)) {
      rejected.push({ raw: item, reason: "plot_reference_not_found" });
      continue;
    }

    // 終わりの行が読めない・逆さまなら、始まりの行だけを指す
    const lineEnd =
      Number.isFinite(lineEndRaw) && lineEndRaw >= lineStart
        ? Math.min(lineEndRaw, lastLine)
        : lineStart;

    passed.push({
      lineStart,
      lineEnd,
      excerpt,
      type,
      reason,
      plotReference,
      severity: level(item.severity),
      confidence: level(item.confidence),
    });
  }

  // **件数を切る。** 1つの話に何件も逸脱があるなら、それは
  // プロットのほうが古いか、AIが探しすぎている
  const budget = deviationBudget(episode.text.length);
  const ordered = sortDeviations(passed);
  accepted.push(...ordered.slice(0, budget));
  for (const extra of ordered.slice(budget)) {
    rejected.push({ raw: extra, reason: "over_budget" });
  }

  return { accepted, rejected };
}

/** 確信度の高いものを上に。切るときに迷っているものだけが残らないように */
export function sortDeviations(items: AcceptedDeviation[]): AcceptedDeviation[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...items].sort((left, right) => {
    if (left.confidence !== right.confidence) {
      return rank[left.confidence] - rank[right.confidence];
    }
    if (left.severity !== right.severity) {
      return rank[left.severity] - rank[right.severity];
    }
    return left.lineStart - right.lineStart;
  });
}

/** 選択肢を写して返されても拾う（矛盾検知・推敲と同じ） */
export function normalizeType(raw: string): DeviationType | undefined {
  const trimmed = raw.trim();
  if (TYPE_SET.has(trimmed)) return trimmed as DeviationType;
  for (const candidate of DEVIATION_TYPES) {
    if (trimmed.startsWith(candidate)) return candidate;
  }
  for (const candidate of DEVIATION_TYPES) {
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
