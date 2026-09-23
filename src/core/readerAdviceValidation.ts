import { isPlaceholderText } from "./placeholderText";
import {
  READER_ADVICE_EXAMPLES,
  READER_ADVICE_LIMITS,
  formatReaderAdviceMaterial,
} from "../prompts/readerAdvice";
import type { ReaderAdviceMaterial } from "./readerAdvice";

/**
 * 読者の反応の助言（P-40）の答えを確かめる（実装ルール3「AIの出力を信用しない」）。
 *
 * - **字数**：上限を超えたら切り詰めて「…」を付け、切ったことを数える
 * - **話数**：答えに出る「第◯話」「◯話目」が記録に実在するか。無い話数には
 *   **印を付ける**（外すと、AIが何を言い間違えたのかが作者に見えない。
 *   記事の目安「50話で約70%」を引いただけの答えを丸ごと消す誤りも避けたい）
 * - **百分率**：材料と例示に無い百分率には印を付ける（数字を作らせない約束の検算）
 * - **指示語の返り**：「全体の見立て」「なし」のように、指示の言葉や中身の無い
 *   言葉がそのまま返ったものは捨てる（CLAUDE.md「繰り返し起きた失敗」3番）
 *
 * VS Code API には依存しない。
 */

export interface ReaderAdvicePoint {
  title: string;
  body: string;
  /** 照合で見つかったこと（「第250話は記録にありません」）。無ければ空 */
  marks: string[];
}

export interface ReaderAdviceAnswer {
  summary: string;
  summaryMarks: string[];
  points: ReaderAdvicePoint[];
  /** 捨てた・切り詰めた件数の説明（画面の下に小さく出す）。無ければ空 */
  notes: string[];
}

/**
 * 指示の言葉。**プロンプトに書いた語が、そのまま答えとして返ってくる**前提で持つ。
 * 欄の名前（summary・title など）も返ってくる。
 */
const INSTRUCTION_ECHOES = [
  "全体の見立て",
  "見立て",
  "作者に見てほしい所",
  "見てほしい所",
  "確かめどころ",
  "見出し",
  "本文",
  "助言",
  "summary",
  "points",
  "title",
  "body",
];

/** 「（120字以内）」「2文以内」だけの答え */
const LIMIT_ECHO = /^[（(]?\s*\d+\s*(字|文)以内\s*[）)]?$/;

/**
 * 応答を読み取って確かめる。**読める項目が1つも無ければ undefined。**
 */
export function validateReaderAdviceAnswer(
  text: string,
  materials: readonly ReaderAdviceMaterial[]
): ReaderAdviceAnswer | undefined {
  const parsed = parseJson(text);
  if (!parsed) return undefined;

  const existing = new Set<number>();
  for (const material of materials) {
    for (const episode of material.existingEpisodes) existing.add(episode);
  }
  const knownPercents = percentsIn(
    [READER_ADVICE_EXAMPLES, ...materials.map(formatReaderAdviceMaterial)].join("\n")
  );

  const notes: string[] = [];
  let trimmed = 0;
  let echoed = 0;

  const clean = (value: unknown, limit: number): string => {
    if (typeof value !== "string") return "";
    const body = value.trim().replace(/\s+/g, " ");
    if (!body) return "";
    if (isEcho(body)) {
      echoed++;
      return "";
    }
    if ([...body].length > limit) {
      trimmed++;
      return [...body].slice(0, limit - 1).join("") + "…";
    }
    return body;
  };

  const summary = clean(parsed.summary, READER_ADVICE_LIMITS.summary);
  const summaryMarks = summary ? marksFor(summary, existing, knownPercents) : [];

  const points: ReaderAdvicePoint[] = [];
  const rawPoints = Array.isArray(parsed.points) ? parsed.points : [];
  let overflow = 0;
  for (const entry of rawPoints) {
    if (!isRecord(entry)) continue;
    const body = clean(entry.body, READER_ADVICE_LIMITS.body);
    // 本文の無い項目は、見出しだけあっても中身が無い
    if (!body) continue;
    if (points.length >= READER_ADVICE_LIMITS.points) {
      overflow++;
      continue;
    }
    const title = clean(entry.title, READER_ADVICE_LIMITS.title);
    points.push({
      title,
      body,
      marks: marksFor(`${title} ${body}`, existing, knownPercents),
    });
  }

  if (!summary && points.length === 0) return undefined;

  if (trimmed > 0) {
    notes.push(`字数の上限を超えた ${trimmed} か所を切り詰めました。`);
  }
  if (echoed > 0) {
    notes.push(`指示の言葉がそのまま返ってきた ${echoed} か所を外しました。`);
  }
  if (overflow > 0) {
    notes.push(
      `見てほしい所が上限（${READER_ADVICE_LIMITS.points}つ）を超えたので、あとの ${overflow} つを外しました。`
    );
  }
  return { summary, summaryMarks, points, notes };
}

function isEcho(body: string): boolean {
  if (isPlaceholderText(body, true)) return true;
  const bare = body.replace(/^[「『"'（(【\s]+|[」』"'）)】。、\s]+$/gu, "");
  if (INSTRUCTION_ECHOES.includes(bare.toLowerCase())) return true;
  return LIMIT_ECHO.test(bare);
}

/**
 * 1つの文に付ける印。**話数は実在を、百分率は材料との一致を見る。**
 */
function marksFor(
  text: string,
  existing: ReadonlySet<number>,
  knownPercents: readonly number[]
): string[] {
  const marks: string[] = [];
  const missing = mentionedEpisodes(text).filter((episode) => !existing.has(episode));
  if (missing.length > 0) {
    marks.push(
      `${missing.map((episode) => `第${episode}話`).join("・")}は、読者の反応の記録にありません（AIの読み違いかもしれません）。`
    );
  }
  const unknown = percentsIn(text).filter(
    (value) => !knownPercents.some((known) => Math.abs(known - value) <= 0.5)
  );
  if (unknown.length > 0) {
    marks.push(
      `${unknown.map((value) => `${value}%`).join("・")}は、渡した材料にない数字です（AIが作った数字かもしれません）。`
    );
  }
  return marks;
}

/**
 * 文に出てくる話数。「第12話」「第3〜5話」「12話目」を拾う。
 *
 * **「50話で」のような裸の話数は拾わない。** 記事の目安（「50話で約70%」）を
 * 引いただけの文が、50話に届かない作品で「無い話」と印を付けられてしまう。
 */
export function mentionedEpisodes(text: string): number[] {
  const normalized = toHalfWidthDigits(text);
  const found = new Set<number>();
  const range = /第\s*(\d+)\s*[〜～~\-－ー]\s*(?:第\s*)?(\d+)\s*話/g;
  for (const match of normalized.matchAll(range)) {
    found.add(Number(match[1]));
    found.add(Number(match[2]));
  }
  for (const match of normalized.matchAll(/第\s*(\d+)\s*話/g)) {
    found.add(Number(match[1]));
  }
  for (const match of normalized.matchAll(/(\d+)\s*話目/g)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((left, right) => left - right);
}

/** 文に出てくる百分率（数値）。「94.0%」「94％」 */
function percentsIn(text: string): number[] {
  const normalized = toHalfWidthDigits(text);
  return [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*[%％]/g)].map((match) =>
    Number(match[1])
  );
}

function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９．]/g, (char) =>
    char === "．" ? "." : String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
