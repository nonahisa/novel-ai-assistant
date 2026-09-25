import { isPlaceholderText } from "./placeholderText";

/**
 * AIが並べた応募先を、コードで確かめる（設計書6.3.6.5、P-42）。
 *
 * **AIの出力を信用しない**（CLAUDE.md 規則3）。
 *
 * - **候補に実在する公募だけを残す。** 番号（C1, C2…）で照合し、番号が無ければ
 *   名前で照合する。AIが候補の外から公募を作っても、画面には出さない
 * - **理由が指示の言葉の返りなら、その提案を外す**（「理由」「（80字以内）」「なし」
 *   「reason」。CLAUDE.md の繰り返し起きた失敗3）。理由の無い提案は選ぶ材料にならない
 * - 同じ公募を2度挙げたら最初の1つ。上限を超えた分は外す。長すぎる理由は切り詰める
 * - **外したものは黙って落とさない**（`notes` に数を書く。画面の下に出す）
 *
 * VS Code API には依存しない。
 */

export const CONTEST_SUGGEST_LIMITS = {
  /** 並べる数の上限 */
  suggestions: 5,
  /** 理由の字数の上限（画面の1行に収まる長さ） */
  reason: 80,
} as const;

export interface SuggestCandidate {
  /** 候補の番号（C1, C2…）。プロンプトで渡したもの */
  readonly id: string;
  readonly name: string;
}

export interface ContestSuggestion {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

/**
 * プロンプトに書いた言葉・欄の名前。**そのまま返ってくる前提で外す。**
 * 「理由」は欄の説明、「応募先に合う理由」はプロンプトの頼み方の言葉。
 */
const INSTRUCTION_ECHOES = [
  "理由",
  "応募先に合う理由",
  "合う理由",
  "提案の理由",
  "候補の番号",
  "番号",
  "公募の名前",
  "reason",
  "id",
  "name",
  "suggestions",
];

/** 「（80字以内）」「1文」だけの答え */
const LIMIT_ECHO = /^[（(]?\s*\d+\s*(字|文)(以内)?\s*[）)]?$/u;

export function validateContestSuggestions(
  text: string,
  candidates: readonly SuggestCandidate[]
): { suggestions: ContestSuggestion[]; notes: string[] } | undefined {
  const parsed = parseJson(text);
  if (!parsed || !Array.isArray(parsed.suggestions)) return undefined;
  // **空の配列は「合う公募なし」という正しい答え**（残課題 F8）。プロンプトが
  // 「合う候補が無ければ空の配列に」と頼んでいる。読めなかったときと同じ
  // undefined にすると、頼んだとおりに答えたAIを失敗として扱うことになる。
  // 挙げたものが検算で全部落ちたときは、下で今までどおり undefined にする
  // （それは「無い」という答えではなく、読める答えが無かった）
  if (parsed.suggestions.length === 0) return { suggestions: [], notes: [] };

  const byId = new Map(candidates.map((candidate) => [idKey(candidate.id), candidate]));
  const byName = new Map(candidates.map((candidate) => [nameKey(candidate.name), candidate]));

  const suggestions: ContestSuggestion[] = [];
  const seen = new Set<string>();
  let unknown = 0;
  let echoed = 0;
  let duplicated = 0;
  let trimmed = 0;
  let overflow = 0;

  for (const entry of parsed.suggestions) {
    if (!isRecord(entry)) continue;
    const candidate =
      (typeof entry.id === "string" ? byId.get(idKey(entry.id)) : undefined) ??
      (typeof entry.name === "string" ? byName.get(nameKey(entry.name)) : undefined);
    if (!candidate) {
      unknown++;
      continue;
    }
    const reasonRaw = typeof entry.reason === "string" ? entry.reason.trim().replace(/\s+/gu, " ") : "";
    if (!reasonRaw || isEcho(reasonRaw)) {
      echoed++;
      continue;
    }
    if (seen.has(candidate.id)) {
      duplicated++;
      continue;
    }
    if (suggestions.length >= CONTEST_SUGGEST_LIMITS.suggestions) {
      overflow++;
      continue;
    }
    let reason = reasonRaw;
    if ([...reason].length > CONTEST_SUGGEST_LIMITS.reason) {
      trimmed++;
      reason = [...reason].slice(0, CONTEST_SUGGEST_LIMITS.reason - 1).join("") + "…";
    }
    seen.add(candidate.id);
    suggestions.push({ id: candidate.id, name: candidate.name, reason });
  }

  if (suggestions.length === 0) return undefined;
  const notes: string[] = [];
  if (unknown > 0) notes.push(`候補に無い公募 ${unknown}件を外しました。`);
  if (echoed > 0) notes.push(`理由が空か、指示の言葉がそのまま返ってきた ${echoed}件を外しました。`);
  if (duplicated > 0) notes.push(`同じ公募を重ねて挙げた ${duplicated}件を外しました。`);
  if (overflow > 0) notes.push(`上限（${CONTEST_SUGGEST_LIMITS.suggestions}件）を超えた ${overflow}件を外しました。`);
  if (trimmed > 0) notes.push(`長すぎる理由 ${trimmed}件を切り詰めました。`);
  return { suggestions, notes };
}

function isEcho(body: string): boolean {
  if (isPlaceholderText(body, true)) return true;
  const bare = body.replace(/^[「『"'（(【\s]+|[」』"'）)】。、\s]+$/gu, "");
  if (INSTRUCTION_ECHOES.includes(bare.toLowerCase())) return true;
  return LIMIT_ECHO.test(bare);
}

function idKey(id: string): string {
  return id.normalize("NFKC").replace(/\s+/gu, "").toUpperCase();
}

function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
