import type { PlotSectionKey, PlotSections } from "./plotDoc";
import { emptyPlotSections } from "./plotDoc";

/**
 * P-02（プロット逆算生成）のAI出力を検証し、プロットの各項目へ変換する。
 *
 * **AIの申告した字数を信じない。** 「80字以内」と指示しても超えて返る。
 * 超えたものは切り詰めず、**そのまま採用候補にしたうえで超過を知らせる**。
 * 途中で切れた文はプロットとして使えないため、直すか捨てるかは作者が決める。
 *
 * VS Code APIに依存しない。
 */

export interface PlotFieldLimit {
  key: PlotSectionKey;
  /** 1項目あたりの上限字数 */
  max: number;
  /** 配列項目の最大件数 */
  maxItems?: number;
}

export const PLOT_LIMITS: readonly PlotFieldLimit[] = [
  { key: "logline", max: 80 },
  { key: "theme", max: 100 },
  { key: "motif", max: 20, maxItems: 5 },
  { key: "worldview", max: 200 },
  { key: "setting", max: 100 },
  { key: "narrativePerson", max: 40 },
  { key: "protagonistMotive", max: 100 },
  { key: "outline", max: 60, maxItems: 20 },
  { key: "mainCharacters", max: 60, maxItems: 10 },
];

export interface PlotValidationResult {
  sections: PlotSections;
  /** 上限を超えた項目の説明。作者に知らせる */
  overLimit: string[];
  /** AIが添えた補足（テーマの別解釈など）。無ければ null */
  notes: string | null;
}

const LIMIT_BY_KEY = new Map(PLOT_LIMITS.map((limit) => [limit.key, limit]));

/** 見出しの表示名。超過の知らせに使う */
const LABELS: Record<PlotSectionKey, string> = {
  title: "タイトル",
  format: "形式",
  genre: "ジャンル",
  logline: "ログライン",
  theme: "テーマ",
  motif: "モチーフ",
  worldview: "世界観",
  setting: "舞台",
  narrativePerson: "人称",
  protagonistMotive: "主人公の行動原理",
  outline: "あらすじ",
  mainCharacters: "主要登場人物",
};

export function parsePlotReverseResult(text: string): Record<string, unknown> | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed)) return parsed;
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

export function validatePlotReverseResult(
  raw: unknown
): PlotValidationResult {
  const sections = emptyPlotSections();
  const overLimit: string[] = [];
  if (!isRecord(raw)) return { sections, overLimit, notes: null };

  const takeText = (key: PlotSectionKey, value: unknown): void => {
    const text = cleanString(value);
    if (!text) return;
    sections[key] = text;
    const limit = LIMIT_BY_KEY.get(key);
    if (limit && text.length > limit.max) {
      overLimit.push(`${LABELS[key]}（${text.length}字 / 目安${limit.max}字）`);
    }
  };

  takeText("logline", raw.logline);
  takeText("theme", raw.theme);
  takeText("worldview", raw.worldview);
  takeText("setting", raw.setting);
  takeText("narrativePerson", raw.narrativePerson);
  takeText("protagonistMotive", raw.protagonistMotive);

  // モチーフは1行に並べる。箇条書きにするほどの分量ではない
  const motif = cleanStringList(raw.motif, LIMIT_BY_KEY.get("motif")?.maxItems);
  if (motif.length > 0) sections.motif = motif.join("、");

  const outlineLimit = LIMIT_BY_KEY.get("outline")!;
  const outline = cleanStringList(raw.outline, outlineLimit.maxItems);
  if (outline.length > 0) {
    sections.outline = outline.map((item) => `- ${item}`).join("\n");
    const longest = Math.max(...outline.map((item) => item.length));
    if (longest > outlineLimit.max) {
      overLimit.push(
        `${LABELS.outline}に長い項目（最長${longest}字 / 目安${outlineLimit.max}字）`
      );
    }
  }

  const charLimit = LIMIT_BY_KEY.get("mainCharacters")!;
  const characters = cleanCharacters(raw.mainCharacters, charLimit.maxItems);
  if (characters.length > 0) {
    sections.mainCharacters = characters
      .map((entry) => `- **${entry.name}**: ${entry.summary}`)
      .join("\n");
    const longest = Math.max(...characters.map((entry) => entry.summary.length));
    if (longest > charLimit.max) {
      overLimit.push(
        `${LABELS.mainCharacters}に長い紹介（最長${longest}字 / 目安${charLimit.max}字）`
      );
    }
  }

  return { sections, overLimit, notes: cleanString(raw.notes) };
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  // AIは「読み取れない」を文字列で返すことがある。空として扱う
  if (!cleaned || cleaned === "null" || cleaned === "不明") return null;
  return cleaned;
}

function cleanStringList(value: unknown, maxItems?: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const text = cleanString(entry);
    if (!text) continue;
    // 同じ項目を並べても読み手の役に立たない
    if (items.includes(text)) continue;
    items.push(text);
    if (maxItems !== undefined && items.length >= maxItems) break;
  }
  return items;
}

function cleanCharacters(
  value: unknown,
  maxItems?: number
): Array<{ name: string; summary: string }> {
  if (!Array.isArray(value)) return [];
  const items: Array<{ name: string; summary: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = cleanString(entry.name);
    const summary = cleanString(entry.summary);
    if (!name || !summary) continue;
    if (items.some((item) => item.name === name)) continue;
    items.push({ name, summary });
    if (maxItems !== undefined && items.length >= maxItems) break;
  }
  return items;
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

export function plotSectionLabel(key: PlotSectionKey): string {
  return LABELS[key];
}
