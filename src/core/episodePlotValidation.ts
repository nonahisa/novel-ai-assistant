import { normalizeForComparison } from "./groundedEvidence";
import { isPlaceholderText } from "./placeholderText";
// 引用の長さの上限は**逸脱検知が持つものを借りる**（設計書6.77の第2段）。
// 以前は同名同値の定数を両方が持っており、片方だけ直す壊れ方ができた
import { MAX_EXCERPT_CHARS } from "./deviationValidation";
import type { EpisodePlotItem } from "./episodePlotDoc";
import {
  EPISODE_PLOT_CHECK_HINTS,
  EPISODE_PLOT_CHECK_KINDS,
  type EpisodePlotCheckKind,
} from "../prompts/episodePlotCheck";
import {
  EPISODE_PLOT_CONTRAST_HINTS,
  EPISODE_PLOT_CONTRAST_KINDS,
  type EpisodePlotContrastKind,
} from "../prompts/episodePlotContrast";

/**
 * 単話プロットのAI判定（P-27・P-28、設計書6.36.3）の応答の検証。
 *
 * **AIの出力を信用しない。** この2つに固有の危うさは、**指した先が
 * 実在しないこと**である。「『王都で剣を買う』は目標に繋がりません」と
 * 言われても、箇条書きにその行が無ければ読みようが無い。
 * 逸脱検知（`deviationValidation.ts`）で `plotReference` を照合したのと
 * 同じ手当てを、最初から入れる。
 *
 * **どちらも「指摘まで」**なので、修正案の検証は無い（そもそも
 * 修正案の欄をスキーマに持たせていない）。
 *
 * VS Code APIに依存しない。
 */

// ── 共通 ─────────────────────────────────────────

export type EpisodePlotRejectReason =
  /** 形が違う（項目が無い・型が違う） */
  | "shape"
  /** 3種のどれでもない */
  | "unknown_kind"
  /** 理由が空、または中身の無い言葉（指示の言い換え） */
  | "placeholder"
  /** 指した箇条書きの行が実在しない */
  | "item_not_found"
  /** 照らした箇条書きの行が実在しない（P-28） */
  | "plot_item_not_found"
  /** 引用が本文に実在しない（P-28） */
  | "excerpt_not_found"
  /** 引用が長すぎる（段落をまるごと写している。P-28） */
  | "excerpt_too_long"
  /** 箇条書きも本文も指していない（P-28）。何も指せない指摘は読めない */
  | "nothing_pointed"
  /** 同じ行への二重の指摘 */
  | "duplicate"
  /** 件数の上限を超えた */
  | "over_budget";

export interface RejectedEpisodePlotFinding {
  raw: unknown;
  reason: EpisodePlotRejectReason;
}

/**
 * 指した箇条書きが実在するか。実在するならその行を返す。
 *
 * **写し方の揺れは許す。** 「- 」を落とす、末尾を省く、といった写し方は
 * 普通に起きる。実在の行に収まっている断片なら、その行を指したものとして
 * 扱う（ただし**短すぎる断片は見ない**――「朝」だけで当たっては、
 * どの行を指しているか決まらない）。
 *
 * 返すのは**実在の行そのもの**である。AIが写した断片をそのまま画面へ
 * 出すと、作者は自分が書いていない文を読むことになる。
 */
export function matchPlotItem(
  raw: string,
  items: readonly EpisodePlotItem[]
): EpisodePlotItem | undefined {
  const needle = normalizeForComparison(raw);
  if (!needle) return undefined;

  const exact = items.find(
    (item) => normalizeForComparison(item.text) === needle
  );
  if (exact) return exact;

  // 短い断片での部分一致は当てにならない（4字は `groundedEvidence` と同じ線）
  if (needle.length < 4) return undefined;
  return items.find((item) =>
    normalizeForComparison(item.text).includes(needle)
  );
}

/**
 * 引用が本文の何行目にあるか（1始まり）。実在しなければ null。
 *
 * **AIに行番号を言わせない。** 本文から機械的に求まる値なので、
 * 言わせるとずれた番号で「ここが違う」と言うことになる
 * （`groundedEvidence.ts` が話数をAIに言わせない理由と同じ）。
 *
 * 照合は正規化した文字列で行うため、**正規化後の位置から元の行へ
 * 戻せるように**、1文字ずつ行番号を控えながら組み立てる。
 */
export function lineOfExcerpt(text: string, excerpt: string): number | null {
  const needle = normalizeForComparison(excerpt);
  if (!needle) return null;

  let normalized = "";
  const lineAt: number[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((line, index) => {
    const body = normalizeForComparison(line);
    for (let i = 0; i < body.length; i++) lineAt.push(index + 1);
    normalized += body;
  });

  const at = normalized.indexOf(needle);
  return at < 0 ? null : (lineAt[at] ?? 1);
}

/**
 * 構造化出力でも前後に説明やコードフェンスが付くモデルがあるため、
 * 生のJSON、コードフェンス除去、最外の波括弧抽出の順で解析する
 * （矛盾検知・伏線検知・章立てと同じ手順）。
 */
export function parseEpisodePlotFindings(
  text: string
): { findings: unknown[] } | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed) && Array.isArray(parsed.findings)) {
        return { findings: parsed.findings };
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

/** 却下の理由を、作者が読める日本語にする */
const REJECT_REASON_LABELS: Record<EpisodePlotRejectReason, string> = {
  shape: "形が違う",
  unknown_kind: "知らない種別",
  placeholder: "理由が空",
  item_not_found: "箇条書きに無い行を指した",
  plot_item_not_found: "箇条書きに無い行を指した",
  excerpt_not_found: "本文に無い引用",
  excerpt_too_long: "引用が長すぎる",
  nothing_pointed: "どこも指していない",
  duplicate: "同じ行への重なり",
  over_budget: "件数の上限超え",
};

/**
 * 却下の内訳を、ログ・通知向けの1行にする。
 *
 * **数だけでは次の一手が決まらない**（章立ての提案と同じ考え方）。
 * `item_not_found` が多ければAIが箇条書きを写せていない（プロンプトの
 * 問題）、`shape` が多ければスキーマの与え方（プロバイダの方言）の問題である。
 */
export function describeEpisodePlotRejects(
  rejected: ReadonlyArray<{ reason: string }>
): string {
  if (rejected.length === 0) return "";
  const counts = new Map<string, number>();
  for (const entry of rejected) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(
      ([reason, count]) =>
        `${
          REJECT_REASON_LABELS[reason as EpisodePlotRejectReason] ?? reason
        } ${count}件`
    )
    .join("、");
}

// ── P-27 展開の検査 ───────────────────────────────

export interface EpisodePlotFinding {
  /** 対象の箇条書き。**実在の行そのもの**（AIが写した断片ではない） */
  item: string;
  /** その行が単話プロットの何行目か（1始まり） */
  line: number;
  kind: EpisodePlotCheckKind;
  reason: string;
}

export function validateEpisodePlotCheck(
  raw: unknown,
  input: { items: readonly EpisodePlotItem[]; maxFindings: number }
): {
  accepted: EpisodePlotFinding[];
  rejected: RejectedEpisodePlotFinding[];
} {
  const accepted: EpisodePlotFinding[] = [];
  const rejected: RejectedEpisodePlotFinding[] = [];
  const seen = new Set<number>();

  for (const entry of findingsOf(raw)) {
    if (!isRecord(entry)) {
      rejected.push({ raw: entry, reason: "shape" });
      continue;
    }
    const item = asString(entry.item);
    const reason = asString(entry.reason);
    if (!item) {
      rejected.push({ raw: entry, reason: "shape" });
      continue;
    }

    const kind = normalizeKind(asString(entry.kind), EPISODE_PLOT_CHECK_KINDS);
    if (!kind) {
      rejected.push({ raw: entry, reason: "unknown_kind" });
      continue;
    }
    const matched = matchPlotItem(item, input.items);
    if (!matched) {
      rejected.push({ raw: entry, reason: "item_not_found" });
      continue;
    }
    if (isEmptyAnswer(reason, EPISODE_PLOT_CHECK_HINTS)) {
      rejected.push({ raw: entry, reason: "placeholder" });
      continue;
    }
    // **同じ行を二度指してくる。** 種別を変えて同じことを言うだけなので、
    // 並べても作者の判断は増えない
    if (seen.has(matched.line)) {
      rejected.push({ raw: entry, reason: "duplicate" });
      continue;
    }

    if (accepted.length >= input.maxFindings) {
      rejected.push({ raw: entry, reason: "over_budget" });
      continue;
    }
    seen.add(matched.line);
    accepted.push({
      item: matched.text,
      line: matched.line,
      kind,
      reason,
    });
  }

  return { accepted, rejected };
}

// ── P-28 本文との照合 ─────────────────────────────

export interface EpisodePlotContrastFinding {
  kind: EpisodePlotContrastKind;
  /** 照らした箇条書きの行。指していなければ null */
  plotItem: string | null;
  /** その行が単話プロットの何行目か。指していなければ null */
  plotLine: number | null;
  /** 本文の引用。指していなければ null */
  excerpt: string | null;
  /** 本文の何行目か（引用から機械的に求める）。引用が無ければ null */
  line: number | null;
  reason: string;
}

export function validateEpisodePlotContrast(
  raw: unknown,
  input: {
    items: readonly EpisodePlotItem[];
    text: string;
    maxFindings: number;
  }
): {
  accepted: EpisodePlotContrastFinding[];
  rejected: RejectedEpisodePlotFinding[];
} {
  const accepted: EpisodePlotContrastFinding[] = [];
  const rejected: RejectedEpisodePlotFinding[] = [];
  const seen = new Set<string>();

  for (const entry of findingsOf(raw)) {
    if (!isRecord(entry)) {
      rejected.push({ raw: entry, reason: "shape" });
      continue;
    }

    const kind = normalizeKind(
      asString(entry.kind),
      EPISODE_PLOT_CONTRAST_KINDS
    );
    if (!kind) {
      rejected.push({ raw: entry, reason: "unknown_kind" });
      continue;
    }
    const reason = asString(entry.reason);
    if (isEmptyAnswer(reason, EPISODE_PLOT_CONTRAST_HINTS)) {
      rejected.push({ raw: entry, reason: "placeholder" });
      continue;
    }

    // 「無い」を言葉で書いてくることがある（`null` ではなく「該当なし」）。
    // 中身の無い言葉は、指していないものとして扱う
    const rawItem = usableOrEmpty(asString(entry.plotItem));
    const rawExcerpt = usableOrEmpty(asString(entry.excerpt));
    if (!rawItem && !rawExcerpt) {
      rejected.push({ raw: entry, reason: "nothing_pointed" });
      continue;
    }

    let excerpt: string | null = null;
    let line: number | null = null;
    if (rawExcerpt) {
      // **段落をまるごと写してくる。** それは引用ではない（P-11と同じ）
      if (rawExcerpt.length > MAX_EXCERPT_CHARS) {
        rejected.push({ raw: entry, reason: "excerpt_too_long" });
        continue;
      }
      line = lineOfExcerpt(input.text, rawExcerpt);
      // **本文に無い文を引いてくる。** 箇条書きの側の文をそのまま
      // 「本文にこうある」と言うことがある（矛盾検知で実際に起きた）
      if (line === null) {
        rejected.push({ raw: entry, reason: "excerpt_not_found" });
        continue;
      }
      excerpt = rawExcerpt;
    }

    let plotItem: string | null = null;
    let plotLine: number | null = null;
    if (rawItem) {
      const matched = matchPlotItem(rawItem, input.items);
      if (!matched) {
        rejected.push({ raw: entry, reason: "plot_item_not_found" });
        continue;
      }
      plotItem = matched.text;
      plotLine = matched.line;
    }

    // 同じ組み合わせを二度並べても、作者の判断は増えない
    const key = `${plotLine ?? ""}:${line ?? ""}:${kind}`;
    if (seen.has(key)) {
      rejected.push({ raw: entry, reason: "duplicate" });
      continue;
    }
    if (accepted.length >= input.maxFindings) {
      rejected.push({ raw: entry, reason: "over_budget" });
      continue;
    }
    seen.add(key);
    accepted.push({ kind, plotItem, plotLine, excerpt, line, reason });
  }

  return { accepted, rejected };
}

// ── 共通の小物 ───────────────────────────────────

function findingsOf(raw: unknown): unknown[] {
  return isRecord(raw) && Array.isArray(raw.findings) ? raw.findings : [];
}

/**
 * 選択肢を写して返されても拾う（矛盾検知・推敲・逸脱と同じ）。
 *
 * 「停滞・重複（同じ場面が続く）」のように、説明を添えて返してくる。
 */
function normalizeKind<T extends string>(
  raw: string,
  kinds: readonly T[]
): T | undefined {
  const trimmed = raw.trim();
  const exact = kinds.find((kind) => kind === trimmed);
  if (exact) return exact;
  const starts = kinds.find((kind) => trimmed.startsWith(kind));
  if (starts) return starts;
  return kinds.find((kind) => trimmed.includes(kind));
}

/**
 * 中身のつもりで書かれた「中身が無い」言葉か。
 *
 * 2種類ある。**どちらも実データで返ってきた形である**（章立ての提案の
 * `isEmptyAnswer` と同じ作り）。
 *
 *   1. 「該当なし」「空文字」のような、中身が無いことを表す言葉
 *   2. **プロンプトの出力例に書いた言い換えそのもの**
 *
 * **2は「丸ごと同じ」ときだけ弾く。** 部分一致で見ると、正当な理由文まで
 * 空扱いになる。
 */
function isEmptyAnswer(text: string, hints: readonly string[]): boolean {
  if (!text.trim()) return true;
  if (isPlaceholderText(text)) return true;
  const body = normalizeForHintMatch(text);
  if (!body) return true;
  return hints.some((hint) => body === normalizeForHintMatch(hint));
}

/** 中身の無い言葉なら空にする（「該当なし」を指し先として扱わない） */
function usableOrEmpty(text: string): string {
  return !text || isPlaceholderText(text) ? "" : text;
}

/**
 * 句読点・かっこ・空白を落とす（ヒント語との照合用）。
 *
 * AIは指示の言葉を返すとき、かっこや読点を添えてくる（`（そう言える理由）`）。
 * **言葉そのものは同じ**なので、これらを落としてから比べる。
 */
function normalizeForHintMatch(text: string): string {
  return text
    .replace(/\s+/gu, "")
    .replace(
      /[、。，．,.:：;；!！?？「」『』（）()〔〕【】《》〈〉[\]{}｛｝“”"'’‘]/gu,
      ""
    );
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
